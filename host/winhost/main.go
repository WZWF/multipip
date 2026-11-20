// Multi-PiP Win32 window host
// -----------------------------------------------------------------------------
// 极简常驻宿主：只做"把 Chrome popup 窗口置顶/取消置顶"这一件事。
// 不承载任何渲染、不内嵌 WebView2，常驻内存约 3MB。
//
// 协议：Chrome Native Messaging（stdin/stdout，4 字节小端长度 + UTF-8 JSON）
//
//	{"cmd":"ping"}                              -> {"ok":true,"ver":"..."}
//	{"cmd":"attach","token":"...","topmost":1}   -> 按窗口标题里的 token 找到 HWND 并置顶
//	{"cmd":"detach","token":"..."}               -> 取消置顶
//	{"cmd":"detachAll"}                          -> 清理全部
//	{"cmd":"quit"}                               -> 退出（退出前自动清理）
//
// 窗口识别：扩展把唯一 token 写进 document.title，这里按标题子串匹配
// Chrome_WidgetWin_1 顶层窗口。窗口刚创建时可能还不存在，attach 会自动重试 3 秒。
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const version = "0.1.0"

const (
	swpNoSize     = 0x0001
	swpNoMove     = 0x0002
	swpNoActivate = 0x0010
	swpNoZOrder   = 0x0004
)

var (
	user32 = syscall.NewLazyDLL("user32.dll")

	procEnumWindows      = user32.NewProc("EnumWindows")
	procIsWindowVisible  = user32.NewProc("IsWindowVisible")
	procGetWindowTextW   = user32.NewProc("GetWindowTextW")
	procGetWindowTextLen = user32.NewProc("GetWindowTextLengthW")
	procGetClassNameW    = user32.NewProc("GetClassNameW")
	procSetWindowPos     = user32.NewProc("SetWindowPos")
	procIsWindow         = user32.NewProc("IsWindow")
)

type request struct {
	Cmd     string `json:"cmd"`
	Token   string `json:"token"`
	Topmost *int   `json:"topmost"`
}

var (
	mu      sync.Mutex
	tracked = map[string]uintptr{} // token -> hwnd
	outMu   sync.Mutex
	out     = os.Stdout
)

func send(v interface{}) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	outMu.Lock()
	defer outMu.Unlock()
	var hdr [4]byte
	binary.LittleEndian.PutUint32(hdr[:], uint32(len(b)))
	_, _ = out.Write(hdr[:])
	_, _ = out.Write(b)
}

func winText(hwnd uintptr) string {
	n := int(mustCall(procGetWindowTextLen, hwnd))
	if n <= 0 {
		return ""
	}
	buf := make([]uint16, n+1)
	mustCall(procGetWindowTextW, hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return syscall.UTF16ToString(buf)
}

func winClass(hwnd uintptr) string {
	buf := make([]uint16, 256)
	mustCall(procGetClassNameW, hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return syscall.UTF16ToString(buf)
}

func mustCall(proc *syscall.LazyProc, args ...uintptr) uintptr {
	r, _, _ := proc.Call(args...)
	return r
}

func isAlive(hwnd uintptr) bool {
	if hwnd == 0 {
		return false
	}
	return mustCall(procIsWindow, hwnd) != 0
}

// findWindow 在所有可见的 Chrome 顶层窗口里找标题含 token 的那个。
func findWindow(token string) uintptr {
	if token == "" {
		return 0
	}
	var found uintptr
	cb := syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		if mustCall(procIsWindowVisible, hwnd) == 0 {
			return 1
		}
		cls := winClass(hwnd)
		if cls != "Chrome_WidgetWin_1" && cls != "Chrome_WidgetWin_0" {
			return 1
		}
		if strings.Contains(winText(hwnd), token) {
			found = hwnd
			return 0 // 停止枚举
		}
		return 1
	})
	procEnumWindows.Call(cb, 0)
	return found
}

func applyTopmost(hwnd uintptr, on bool) bool {
	if !isAlive(hwnd) {
		return false
	}
	var after uintptr
	if on {
		after = ^uintptr(0) // HWND_TOPMOST (-1)
	} else {
		after = ^uintptr(1) // HWND_NOTOPMOST (-2)
	}
	flags := uintptr(swpNoMove | swpNoSize | swpNoActivate)
	r := mustCall(procSetWindowPos, hwnd, after, 0, 0, 0, 0, flags)
	return r != 0
}

// attachWithRetry 解决"窗口晚于 attach 指令出现"的竞态。
func attachWithRetry(token string, on bool) (uintptr, bool) {
	for i := 0; i < 30; i++ {
		if hwnd := findWindow(token); hwnd != 0 {
			if applyTopmost(hwnd, on) {
				return hwnd, true
			}
			return 0, false
		}
		time.Sleep(100 * time.Millisecond)
	}
	return 0, false
}

func handle(req request) {
	switch req.Cmd {
	case "ping":
		send(map[string]interface{}{"ok": true, "pong": true, "ver": version})

	case "attach":
		on := true
		if req.Topmost != nil {
			on = *req.Topmost != 0
		}
		go func() {
			hwnd, ok := attachWithRetry(req.Token, on)
			if !ok {
				send(map[string]interface{}{"ok": false, "token": req.Token, "error": "window not found"})
				return
			}
			mu.Lock()
			if on {
				tracked[req.Token] = hwnd
			} else {
				delete(tracked, req.Token)
			}
			mu.Unlock()
			send(map[string]interface{}{
				"ok": true, "token": req.Token, "hwnd": fmt.Sprintf("0x%x", hwnd),
				"topmost": on, "title": winText(hwnd),
			})
		}()

	case "detach":
		mu.Lock()
		hwnd := tracked[req.Token]
		delete(tracked, req.Token)
		mu.Unlock()
		if hwnd == 0 {
			hwnd = findWindow(req.Token)
		}
		ok := hwnd != 0 && applyTopmost(hwnd, false)
		send(map[string]interface{}{"ok": ok, "token": req.Token})

	case "detachAll":
		mu.Lock()
		items := make([]string, 0, len(tracked))
		for token, hwnd := range tracked {
			applyTopmost(hwnd, false)
			items = append(items, token)
		}
		tracked = map[string]uintptr{}
		mu.Unlock()
		send(map[string]interface{}{"ok": true, "cleared": len(items)})

	case "quit":
		cleanup()
		send(map[string]interface{}{"ok": true, "bye": true})
		os.Exit(0)

	default:
		send(map[string]interface{}{"ok": false, "error": "unknown cmd: " + req.Cmd})
	}
}

func cleanup() {
	mu.Lock()
	for token, hwnd := range tracked {
		applyTopmost(hwnd, false)
		delete(tracked, token)
	}
	mu.Unlock()
}

func main() {
	// 注意：stdin EOF 时【故意】不还原置顶。
	// MV3 的 service worker 空闲被回收时也会断开管道，若此时还原置顶，
	// 用户会看到"窗口突然掉出置顶"。还原只走显式 detach / detachAll / quit。

	send(map[string]interface{}{"event": "ready", "ver": version, "pid": os.Getpid()})

	reader := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		var hdr [4]byte
		if _, err := io.ReadFull(reader, hdr[:]); err != nil {
			return
		}
		n := binary.LittleEndian.Uint32(hdr[:])
		if n == 0 || n > 1<<20 {
			return
		}
		buf := make([]byte, n)
		if _, err := io.ReadFull(reader, buf); err != nil {
			return
		}
		var req request
		if err := json.Unmarshal(buf, &req); err != nil {
			send(map[string]interface{}{"ok": false, "error": "bad json: " + err.Error()})
			continue
		}
		handle(req)
	}
}
