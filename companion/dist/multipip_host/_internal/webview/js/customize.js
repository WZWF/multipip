
(function() {
    var platform = window.pywebview.platform;
    var disableText = '%(text_select)s' === 'False';
    var disableTextCss = 'body {-webkit-user-select: none; -khtml-user-select: none; -ms-user-select: none; user-select: none; cursor: default;}'

    if (platform == 'mshtml') {
        window.alert = function(msg) {
            window.external.alert(msg);
        }
    } else if (platform == 'edgechromium') {
        window.alert = function (message) {
            window.chrome.webview.postMessage(['_pywebviewAlert', pywebview.stringify(message), 'alert']);
        }
    } else if (platform == 'gtkwebkit2') {
        window.alert = function (message) {
            window.webkit.messageHandlers.jsBridge.postMessage(pywebview.stringify({funcName: '_pywebviewAlert', params: message, id: 'alert'}));
        }
    } else if (platform == 'cocoa') {
        window.print = function() {
            window.webkit.messageHandlers.browserDelegate.postMessage('print');
        }
    } else if (platform === 'qtwebengine') {
        window.alert = function (message) {
            window.pywebview._QWebChannel.objects.external.call('_pywebviewAlert', pywebview.stringify(message), 'alert');
        }
    } else if (platform === 'qtwebkit') {
        window.alert = function (message) {
            window.external.invoke(JSON.stringify(['_pywebviewAlert', message, 'alert']));
        }
    }

    if (disableText) {
        var css = document.createElement("style");
        css.type = "text/css";
        css.innerHTML = disableTextCss;
        document.head.appendChild(css);
    }

    function disableTouchEvents() {
        var initialX = 0;
        var initialY = 0;

        function onMouseMove(ev) {
            var x = ev.screenX - initialX;
            var y = ev.screenY - initialY;
            window.pywebview._jsApiCallback('pywebviewMoveWindow', [x, y], 'move');
        }

        function onMouseUp() {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        }

        function onMouseDown(ev) {
            if (
                '%(drag_region_direct_target_only)s' === 'True' &&
                !ev.target.matches('%(drag_selector)s')
            ) {
                return
            }

            initialX = ev.clientX;
            initialY = ev.clientY;
            window.addEventListener('mouseup', onMouseUp);
            window.addEventListener('mousemove', onMouseMove);
        }

        function onBodyMouseDown(event) {
            var target = event.target;
            var dragSelectorElements = document.querySelectorAll('%(drag_selector)s');

            while (target && target !== document.body && target !== document.documentElement) {
                if (target.nodeType === 1) {
                    // Check if target matches the drag selector
                    for (var i = 0; i < dragSelectorElements.length; i++) {
                        if (dragSelectorElements[i] === target) {
                            onMouseDown(event);
                            return;
                        }
                    }
                }

                // If it doesn't match, continue up the DOM tree
                target = target.parentNode;
            }
        }

        document.body.addEventListener('mousedown', onBodyMouseDown);

            // easy drag for edge chromium
        if ('%(easy_drag)s' === 'True') {
            window.addEventListener('mousedown', onMouseDown);
        }

        if ('%(zoomable)s' === 'False') {
            document.body.addEventListener('touchstart', function(e) {
                if ((e.touches.length > 1) || e.targetTouches.length > 1) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                }
            }, {passive: false});

            window.addEventListener('wheel', function (e) {
                if (e.ctrlKey) {
                    e.preventDefault();
                }
            }, {passive: false});
        }

        // draggable
        if ('%(draggable)s' === 'False') {
            document.addEventListener('dragstart', function(e) {
                if (e.target.tagName === 'IMG' || e.target.tagName === 'A') {
                    e.preventDefault();
                }
            });
        }
    }

    disableTouchEvents();

    // -------------------------------- 沉浸式纯黑自动隐藏工具条与控制栏 --------------------------------
    (function setupImmersiveControls() {
        function initAutoFade() {
            var s = document.createElement('style');
            s.id = '__mp_immersive_style';
            s.textContent = [
                '#__mp_drag_titlebar, #__mp_host_ui, #__mp_controls {',
                '  opacity: 0 !important;',
                '  pointer-events: none !important;',
                '  transition: opacity .25s ease !important;',
                '}',
                'body.mp-active #__mp_drag_titlebar {',
                '  opacity: 0.18 !important;',
                '  pointer-events: auto !important;',
                '}',
                'body.mp-active #__mp_drag_titlebar:hover {',
                '  opacity: 1 !important;',
                '}',
                'body.mp-active #__mp_host_ui {',
                '  opacity: 0.88 !important;',
                '  pointer-events: auto !important;',
                '}',
                'body.mp-active #__mp_host_ui:hover {',
                '  opacity: 1 !important;',
                '}',
                'body.mp-active #__mp_controls {',
                '  opacity: 0.92 !important;',
                '  pointer-events: auto !important;',
                '}',
                'body.mp-active #__mp_controls:hover {',
                '  opacity: 1 !important;',
                '}'
            ].join('\n');
            (document.head || document.documentElement).appendChild(s);

            var idleTimer = 0;
            function onUserActivity() {
                document.body.classList.add('mp-active');
                clearTimeout(idleTimer);
                idleTimer = setTimeout(function() {
                    document.body.classList.remove('mp-active');
                }, 2200);
            }

            window.addEventListener('mousemove', onUserActivity);
            window.addEventListener('pointermove', onUserActivity);
            window.addEventListener('mousedown', onUserActivity);
            window.addEventListener('keydown', onUserActivity);

            // 窗口打开初期短暂展示 1.8 秒后淡出隐形，告知用户功能控件位置
            document.body.classList.add('mp-active');
            idleTimer = setTimeout(function() {
                document.body.classList.remove('mp-active');
            }, 1800);
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initAutoFade);
        } else {
            initAutoFade();
        }
    })();
  })();
