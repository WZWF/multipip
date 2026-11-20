// Multi-PiP Win32 window host
// -----------------------------------------------------------------------------
// 极简常驻宿主，只做三件与"窗口外形/层级"有关的事，不承载任何渲染：
//   1. 把目标窗口设为 HWND_TOPMOST
//   2. 用 SetWindowRgn 精确裁掉 Chrome popup 的标题/地址栏区域（只留页面客户区，可圆角）
//   3. 接管原生拖动与等比缩放（裁边后窗口自身的边框被切掉，必须由宿主接手）
//
// 协议：Chrome Native Messaging（stdin/stdout，4 字节小端长度 + UTF-8 JSON）
//
//	{"cmd":"ping"}                                  -> {"ok":true,"ver":"..."}
//	{"cmd":"attach","token":"...","topmost":1,       -> 认领窗口；cut=1 时立即裁剪
//	                 "cut":1,"radius":10,"class":"..."}
//	{"cmd":"setcut","token":"...","cut":0|1,"radius":10}
//	{"cmd":"drag","token":"..."}                     -> 原生拖动循环（松开左键自动结束）
//	{"cmd":"resize","token":"...","aspect":1.7778}   -> 等比缩放循环（按住左键期间）
//	{"cmd":"status","token":"..."}                   -> 调试：是否已置顶/已裁剪
//	{"cmd":"tile","tokens":["..",".."],"mode":"grid"} -> 按监视器工作区宫格/横排平铺
//	{"cmd":"detach","token":"..."}                   -> 取消置顶 + 还原窗口区域
//	{"cmd":"detachAll"} / {"cmd":"quit"}
//
// 窗口识别：扩展把唯一 token 写进 document.title，这里按标题子串匹配顶层窗口，
// 默认只匹配 Chrome 系窗口类（可用 class 字段覆盖，便于用记事本做无人验证）。
//
// 关键实现取舍：
//   - stdin EOF 时【不】还原置顶/区域。MV3 service worker 空闲被回收会断开管道，
//     若此时还原，用户会看到窗口突然掉出置顶。
//   - 裁剪区每 400ms 校验一次（EqualRgn 比较），Chrome 因重绘/换 DPI/改尺寸重置
//     Region 时自动补刷，无需 SetWinEventHook。
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

const version = "0.2.0"

const (
	swpNoSize     = 0x0001
	swpNoMove     = 0x0002
	swpNoZOrder   = 0x0004
	swpNoActivate = 0x0010

	vkLButton = 0x01

	// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == (DPI_AWARENESS_CONTEXT)-4
	dpiAwarenessPerMonitorV2 = ^uintptr(3)
)

var (
	user32 = syscall.NewLazyDLL("user32.dll")
	gdi32  = syscall.NewLazyDLL("gdi32.dll")

	procEnumWindows        = user32.NewProc("EnumWindows")
	procIsWindowVisible    = user32.NewProc("IsWindowVisible")
	procIsWindow           = user32.NewProc("IsWindow")
	procGetWindowTextW     = user32.NewProc("GetWindowTextW")
	procGetWindowTextLen   = user32.NewProc("GetWindowTextLengthW")
	procGetClassNameW      = user32.NewProc("GetClassNameW")
	procSetWindowPos       = user32.NewProc("SetWindowPos")
	procGetWindowRect      = user32.NewProc("GetWindowRect")
	procGetClientRect      = user32.NewProc("GetClientRect")
	procClientToScreen     = user32.NewProc("ClientToScreen")
	procGetCursorPos       = user32.NewProc("GetCursorPos")
	procGetAsyncKeyState   = user32.NewProc("GetAsyncKeyState")
	procSetWindowRgn       = user32.NewProc("SetWindowRgn")
	procGetWindowRgn       = user32.NewProc("GetWindowRgn")
	procSetDpiCtx          = user32.NewProc("SetProcessDpiAwarenessContext")
	procSetDpiAware        = user32.NewProc("SetProcessDPIAware")
	procCreateRectRgn      = gdi32.NewProc("CreateRectRgn")
	procCreateRoundRectRgn = gdi32.NewProc("CreateRoundRectRgn")
	procDeleteObject       = gdi32.NewProc("DeleteObject")
	procEqualRgn           = gdi32.NewProc("EqualRgn")
	procMonitorFromWindow  = user32.NewProc("MonitorFromWindow")
	procGetMonitorInfoW    = user32.NewProc("GetMonitorInfoW")
)

type point struct{ X, Y int32 }
type rect struct{ Left, Top, Right, Bottom int32 }

type request struct {
	Cmd     string  `json:"cmd"`
	Token   string  `json:"token"`
	Class   string  `json:"class"`
	Topmost *int    `json:"topmost"`
	Cut     *int    `json:"cut"`
	Radius  *int    `json:"radius"`
	Aspect  float64  `json:"aspect"`
	Tokens  []string `json:"tokens"`
	Mode    string   `json:"mode"`
}

type target struct {
	token   string
	hwnd    uintptr
	topmost bool
	cut     bool
	radius  int
	done    chan struct{} // detach / 重挂时关闭，停了区域巡检
	loop    chan struct{} // 拖动/缩放的会话（新的会打断旧的）
}

var (
	mu      sync.Mutex
	targets = map[string]*target{}

	outMu sync.Mutex
	out   = os.Stdout
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

func call(proc *syscall.LazyProc, args ...uintptr) uintptr {
	r, _, _ := proc.Call(args...)
	return r
}

func ptr(v unsafe.Pointer) uintptr { return uintptr(v) }

func winText(hwnd uintptr) string {
	n := int(call(procGetWindowTextLen, hwnd))
	if n <= 0 {
		return ""
	}
	buf := make([]uint16, n+1)
	call(procGetWindowTextW, hwnd, ptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return syscall.UTF16ToString(buf)
}

func winClass(hwnd uintptr) string {
	buf := make([]uint16, 256)
	call(procGetClassNameW, hwnd, ptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return syscall.UTF16ToString(buf)
}

func isAlive(hwnd uintptr) bool {
	return hwnd != 0 && call(procIsWindow, hwnd) != 0
}

func windowRect(hwnd uintptr) (rect, bool) {
	var r rect
	return r, call(procGetWindowRect, hwnd, ptr(unsafe.Pointer(&r))) != 0
}

func clientRect(hwnd uintptr) (rect, bool) {
	var r rect
	return r, call(procGetClientRect, hwnd, ptr(unsafe.Pointer(&r))) != 0
}

func clientOrigin(hwnd uintptr) (point, bool) {
	var p point
	return p, call(procClientToScreen, hwnd, ptr(unsafe.Pointer(&p))) != 0
}

func cursorPos() point {
	var p point
	call(procGetCursorPos, ptr(unsafe.Pointer(&p)))
	return p
}

func lbuttonDown() bool {
	return call(procGetAsyncKeyState, vkLButton)&0x8000 != 0
}

// findWindow 在所有可见的指定类名顶层窗口里找标题含 token 的那个。
func findWindow(token, class string) uintptr {
	if token == "" {
		return 0
	}
	classes := map[string]bool{}
	if class != "" {
		classes[class] = true
	} else {
		classes["Chrome_WidgetWin_1"] = true
		classes["Chrome_WidgetWin_0"] = true
	}

	var found uintptr
	cb := syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		if call(procIsWindowVisible, hwnd) == 0 {
			return 1
		}
		if !classes[winClass(hwnd)] {
			return 1
		}
		if strings.Contains(winText(hwnd), token) {
			found = hwnd
			return 0
		}
		return 1
	})
	call(procEnumWindows, cb, 0)
	return found
}

// ---------------------------------------------------------------------------
// Region：只保留"页面客户区"，把 Chrome 自绘的标题/地址栏条和不可见边框一起切掉
// ---------------------------------------------------------------------------

func computeRegion(hwnd uintptr, radius int) (uintptr, bool, string) {
	wr, ok1 := windowRect(hwnd)
	cr, ok2 := clientRect(hwnd)
	co, ok3 := clientOrigin(hwnd)
	if !ok1 || !ok2 || !ok3 {
		return 0, false, "get rect failed"
	}
	w := cr.Right - cr.Left
	h := cr.Bottom - cr.Top
	if w < 80 || h < 60 {
		return 0, false, fmt.Sprintf("client too small %dx%d", w, h)
	}
	left := int32(co.X) - wr.Left
	top := int32(co.Y) - wr.Top
	r := radius
	if r < 0 {
		r = 0
	}
	if int32(r*2) >= w || int32(r*2) >= h {
		r = 0
	}
	// 四周各留 1px，避免边缘出现 1px 白线/灰线
	x1, y1 := left-1, top-1
	x2, y2 := left+w+1, top+h+1
	var hRgn uintptr
	if r > 0 {
		hRgn = call(procCreateRoundRectRgn,
			uintptr(x1), uintptr(y1), uintptr(x2), uintptr(y2),
			uintptr(r*2), uintptr(r*2))
	} else {
		hRgn = call(procCreateRectRgn, uintptr(x1), uintptr(y1), uintptr(x2), uintptr(y2))
	}
	if hRgn == 0 {
		return 0, false, "CreateRgn failed"
	}
	return hRgn, true, ""
}

func regionMatches(hwnd, want uintptr) bool {
	cur := call(procCreateRectRgn, 0, 0, 1, 1)
	if cur == 0 {
		return false
	}
	defer call(procDeleteObject, cur)
	got := call(procGetWindowRgn, hwnd, cur)
	if got < 2 { // 0=ERROR 1=NULLREGION
		return false
	}
	return call(procEqualRgn, cur, want) != 0
}

func applyRegion(t *target) (bool, string) {
	if !isAlive(t.hwnd) {
		return false, "window gone"
	}
	mu.Lock()
	cut, radius := t.cut, t.radius
	mu.Unlock()
	if !cut {
		call(procSetWindowRgn, t.hwnd, 0, 1)
		return true, "cleared"
	}
	rgn, ok, err := computeRegion(t.hwnd, radius)
	if !ok {
		return false, err
	}
	if regionMatches(t.hwnd, rgn) {
		call(procDeleteObject, rgn)
		return true, "unchanged"
	}
	if call(procSetWindowRgn, t.hwnd, rgn, 1) == 0 {
		call(procDeleteObject, rgn) // 失败时 rgn 仍归调用方所有
		return false, "SetWindowRgn failed"
	}
	return true, "applied"
}

// watchRegion 每 400ms 校验一次：Chrome 重绘/换 DPI/改尺寸会把 Region 丢掉，这里补刷。
func watchRegion(t *target) {
	tk := time.NewTicker(400 * time.Millisecond)
	defer tk.Stop()
	for {
		select {
		case <-t.done:
			return
		case <-tk.C:
			if !isAlive(t.hwnd) {
				return
			}
			mu.Lock()
			cut := t.cut
			mu.Unlock()
			if cut {
				_, _ = applyRegion(t)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// 监视器工作区 / 边缘吸附 / 宫格平铺
// ---------------------------------------------------------------------------

type monitorInfo struct {
	cbSize    uint32
	rcMonitor rect
	rcWork    rect
	dwFlags   uint32
}

func workArea(hwnd uintptr) (rect, bool) {
	hmon := call(procMonitorFromWindow, hwnd, 2) // MONITOR_DEFAULTTONEAREST
	if hmon == 0 {
		return rect{}, false
	}
	mi := monitorInfo{cbSize: uint32(unsafe.Sizeof(monitorInfo{}))}
	if call(procGetMonitorInfoW, hmon, ptr(unsafe.Pointer(&mi))) == 0 {
		return rect{}, false
	}
	return mi.rcWork, true
}

func visualRect(hwnd uintptr) (x, y, w, h int32, ok bool) {
	co, ok1 := clientOrigin(hwnd)
	cr, ok2 := clientRect(hwnd)
	if !ok1 || !ok2 {
		return 0, 0, 0, 0, false
	}
	return co.X, co.Y, cr.Right - cr.Left, cr.Bottom - cr.Top, true
}

func abs32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}

// snapWindow 在拖动结束后把窗口吸附到工作区边缘（阈值 24px，按"可见客户区"算）。
func snapWindow(hwnd uintptr) {
	const tol int32 = 24
	vx, vy, vw, vh, ok := visualRect(hwnd)
	if !ok {
		return
	}
	work, ok := workArea(hwnd)
	if !ok {
		return
	}
	nx, ny := vx, vy
	if abs32(vx-work.Left) < tol {
		nx = work.Left
	}
	if abs32((vx+vw)-work.Right) < tol {
		nx = work.Right - vw
	}
	if abs32(vy-work.Top) < tol {
		ny = work.Top
	}
	if abs32((vy+vh)-work.Bottom) < tol {
		ny = work.Bottom - vh
	}
	if nx == vx && ny == vy {
		return
	}
	wr, ok := windowRect(hwnd)
	if !ok {
		return
	}
	call(procSetWindowPos, hwnd, 0,
		uintptr(wr.Left+(nx-vx)), uintptr(wr.Top+(ny-vy)), 0, 0,
		uintptr(swpNoSize|swpNoZOrder|swpNoActivate))
}

// tileWindows 按工作区把若干窗口铺成宫格（grid）或横向一列（row）。
func tileWindows(tokens []string, mode string) int {
	hwnds := make([]uintptr, 0, len(tokens))
	for _, tk := range tokens {
		if t := lookup(tk); t != nil && isAlive(t.hwnd) {
			hwnds = append(hwnds, t.hwnd)
		}
	}
	n := len(hwnds)
	if n == 0 {
		return 0
	}
	work, ok := workArea(hwnds[0])
	if !ok {
		return 0
	}
	const gap int32 = 8

	var cols, rows int32
	if mode == "row" {
		cols, rows = int32(n), 1
	} else {
		cols = 1
		for cols*cols < int32(n) {
			cols++
		}
		rows = (int32(n) + cols - 1) / cols
	}
	totalW := work.Right - work.Left
	totalH := work.Bottom - work.Top
	w := (totalW - gap*(cols+1)) / cols
	h := (totalH - gap*(rows+1)) / rows
	if w < 160 || h < 90 {
		return 0
	}
	applied := 0
	for i, hwnd := range hwnds {
		idx := int32(i)
		col := idx % cols
		row := idx / cols
		x := work.Left + gap + col*(w+gap)
		y := work.Top + gap + row*(h+gap)
		// 平铺的是"窗口外框"，客户区会比它小一点；对拆窗（已裁边）影响很小
		if call(procSetWindowPos, hwnd, 0, uintptr(x), uintptr(y),
			uintptr(w), uintptr(h),
			uintptr(swpNoZOrder|swpNoActivate)) != 0 {
			applied++
		}
	}
	return applied
}

// ---------------------------------------------------------------------------
// 原生拖动 / 等比缩放
// ---------------------------------------------------------------------------

func dragLoop(t *target, stop chan struct{}) {
	start := cursorPos()
	wr, ok := windowRect(t.hwnd)
	if !ok {
		return
	}
	for {
		select {
		case <-stop:
			return
		default:
		}
		if !isAlive(t.hwnd) || !lbuttonDown() {
			snapWindow(t.hwnd) // 松手后吸附到屏幕边缘
			return
		}
		p := cursorPos()
		nx := wr.Left + (p.X - start.X)
		ny := wr.Top + (p.Y - start.Y)
		call(procSetWindowPos, t.hwnd, 0,
			uintptr(nx), uintptr(ny), 0, 0,
			uintptr(swpNoSize|swpNoZOrder|swpNoActivate))
		time.Sleep(8 * time.Millisecond)
	}
}

func resizeLoop(t *target, aspect float64, stop chan struct{}) {
	start := cursorPos()
	wr, ok := windowRect(t.hwnd)
	if !ok {
		return
	}
	startW := int(wr.Right - wr.Left)
	startH := int(wr.Bottom - wr.Top)
	for {
		select {
		case <-stop:
			return
		default:
		}
		if !isAlive(t.hwnd) || !lbuttonDown() {
			return
		}
		p := cursorPos()
		w := startW + int(p.X-start.X)
		if w < 240 {
			w = 240
		}
		var h int
		if aspect > 0.2 {
			h = int(float64(w) / aspect)
		} else {
			h = startH + int(p.Y-start.Y)
		}
		if h < 140 {
			h = 140
		}
		call(procSetWindowPos, t.hwnd, 0, 0, 0,
			uintptr(w), uintptr(h),
			uintptr(swpNoMove|swpNoZOrder|swpNoActivate))
		time.Sleep(8 * time.Millisecond)
	}
}

func stopLoop(t *target) {
	mu.Lock()
	ch := t.loop
	t.loop = nil
	mu.Unlock()
	if ch != nil {
		close(ch)
	}
}

func startLoop(t *target) chan struct{} {
	stopLoop(t)
	ch := make(chan struct{})
	mu.Lock()
	t.loop = ch
	mu.Unlock()
	return ch
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

func lookup(token string) *target {
	mu.Lock()
	defer mu.Unlock()
	return targets[token]
}

func clearWindow(t *target) {
	if t == nil {
		return
	}
	stopLoop(t)
	if isAlive(t.hwnd) {
		call(procSetWindowPos, t.hwnd, ^uintptr(1), 0, 0, 0, 0,
			uintptr(swpNoMove|swpNoSize|swpNoActivate))
		call(procSetWindowRgn, t.hwnd, 0, 1)
	}
	mu.Lock()
	if t.done != nil {
		close(t.done)
		t.done = nil
	}
	mu.Unlock()
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
		cut := false
		if req.Cut != nil {
			cut = *req.Cut != 0
		}
		radius := 10
		if req.Radius != nil {
			radius = *req.Radius
		}
		go func() {
			var hwnd uintptr
			for i := 0; i < 30; i++ {
				if hwnd = findWindow(req.Token, req.Class); hwnd != 0 {
					break
				}
				time.Sleep(100 * time.Millisecond)
			}
			if hwnd == 0 {
				send(map[string]interface{}{"ok": false, "token": req.Token, "error": "window not found"})
				return
			}
			if on {
				call(procSetWindowPos, hwnd, ^uintptr(0), 0, 0, 0, 0,
					uintptr(swpNoMove|swpNoSize|swpNoActivate))
			}
			if old := lookup(req.Token); old != nil {
				clearWindow(old)
			}
			t := &target{
				token: req.Token, hwnd: hwnd, topmost: on,
				cut: cut, radius: radius, done: make(chan struct{}),
			}
			mu.Lock()
			targets[req.Token] = t
			mu.Unlock()

			state, msg := applyRegion(t)
			if cut {
				go watchRegion(t)
			}
			send(map[string]interface{}{
				"ok": true, "token": req.Token, "hwnd": fmt.Sprintf("0x%x", hwnd),
				"topmost": on, "cut": cut, "radius": radius,
				"region": msg, "regionOk": state, "title": winText(hwnd),
			})
		}()

	case "setcut":
		t := lookup(req.Token)
		if t == nil {
			send(map[string]interface{}{"ok": false, "token": req.Token, "error": "not attached"})
			return
		}
		mu.Lock()
		if req.Cut != nil {
			t.cut = *req.Cut != 0
		}
		if req.Radius != nil {
			t.radius = *req.Radius
		}
		cut, radius := t.cut, t.radius
		mu.Unlock()
		ok, msg := applyRegion(t)
		send(map[string]interface{}{"ok": ok, "token": req.Token, "cut": cut, "radius": radius, "region": msg})

	case "drag":
		t := lookup(req.Token)
		if t == nil {
			send(map[string]interface{}{"ok": false, "error": "not attached"})
			return
		}
		go dragLoop(t, startLoop(t))
		send(map[string]interface{}{"ok": true, "token": req.Token})

	case "resize":
		t := lookup(req.Token)
		if t == nil {
			send(map[string]interface{}{"ok": false, "error": "not attached"})
			return
		}
		go resizeLoop(t, req.Aspect, startLoop(t))
		send(map[string]interface{}{"ok": true, "token": req.Token, "aspect": req.Aspect})

	case "status":
		t := lookup(req.Token)
		if t == nil {
			send(map[string]interface{}{"ok": false, "error": "not attached"})
			return
		}
		wr, _ := windowRect(t.hwnd)
		cr, _ := clientRect(t.hwnd)
		cur := call(procCreateRectRgn, 0, 0, 1, 1)
		got := uintptr(0)
		if cur != 0 {
			got = call(procGetWindowRgn, t.hwnd, cur)
			call(procDeleteObject, cur)
		}
		mu.Lock()
		cut, radius, top := t.cut, t.radius, t.topmost
		mu.Unlock()
		send(map[string]interface{}{
			"ok": true, "token": req.Token, "hwnd": fmt.Sprintf("0x%x", t.hwnd),
			"alive": isAlive(t.hwnd), "topmost": top, "cut": cut, "radius": radius,
			"regionSet": got >= 2, "regionType": got,
			"window": []int32{wr.Left, wr.Top, wr.Right - wr.Left, wr.Bottom - wr.Top},
			"client": []int32{cr.Right - cr.Left, cr.Bottom - cr.Top},
		})

	case "tile":
		applied := tileWindows(req.Tokens, req.Mode)
		send(map[string]interface{}{"ok": applied > 0, "applied": applied, "total": len(req.Tokens), "mode": req.Mode})

	case "detach":
		mu.Lock()
		t := targets[req.Token]
		delete(targets, req.Token)
		mu.Unlock()
		clearWindow(t)
		send(map[string]interface{}{"ok": true, "token": req.Token})

	case "detachAll":
		mu.Lock()
		all := targets
		targets = map[string]*target{}
		mu.Unlock()
		for _, t := range all {
			clearWindow(t)
		}
		send(map[string]interface{}{"ok": true, "cleared": len(all)})

	case "quit":
		mu.Lock()
		all := targets
		targets = map[string]*target{}
		mu.Unlock()
		for _, t := range all {
			clearWindow(t)
		}
		send(map[string]interface{}{"ok": true, "bye": true})
		os.Exit(0)

	default:
		send(map[string]interface{}{"ok": false, "error": "unknown cmd: " + req.Cmd})
	}
}

func main() {
	// 必须先声明 DPI 感知，否则 GetWindowRect/SetWindowRgn 用虚拟坐标，裁剪会错位。
	if call(procSetDpiCtx, dpiAwarenessPerMonitorV2) == 0 {
		call(procSetDpiAware)
	}

	send(map[string]interface{}{"event": "ready", "ver": version, "pid": os.Getpid()})

	reader := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		var hdr [4]byte
		if _, err := io.ReadFull(reader, hdr[:]); err != nil {
			// EOF：刻意不还原置顶/区域（MV3 SW 被回收时会走到这里）
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
