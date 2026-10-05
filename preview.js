    (function() {
        const app = document.getElementById('app');
        const themeAuto = document.getElementById('themeAuto');
        const themeLight = document.getElementById('themeLight');
        const themeDark = document.getElementById('themeDark');
        const allBtns = [themeAuto, themeLight, themeDark];

        function setActiveBtn(activeBtn) {
            allBtns.forEach(btn => btn.classList.remove('active'));
            if (activeBtn) activeBtn.classList.add('active');
        }

        function setTheme(mode) {
            // 主题变量定义在 :root 上，body 背景也读取 :root 变量，
            // 因此 data-theme 必须挂在 <html>（documentElement）上，才能让整页（含大背景）一起切换
            const root = document.documentElement;
            root.removeAttribute('data-theme');
            if (mode === 'light') {
                root.setAttribute('data-theme', 'light');
                setActiveBtn(themeLight);
            } else if (mode === 'dark') {
                root.setAttribute('data-theme', 'dark');
                setActiveBtn(themeDark);
            } else {
                root.removeAttribute('data-theme');
                setActiveBtn(themeAuto);
            }
            try {
                localStorage.setItem('mr-chat-theme', mode);
            } catch(e) {}
        }

        function loadTheme() {
            let saved = 'auto';
            try {
                const stored = localStorage.getItem('mr-chat-theme');
                if (stored === 'light' || stored === 'dark' || stored === 'auto') {
                    saved = stored;
                }
            } catch(e) {}
            setTheme(saved);
        }

        themeAuto.addEventListener('click', () => setTheme('auto'));
        themeLight.addEventListener('click', () => setTheme('light'));
        themeDark.addEventListener('click', () => setTheme('dark'));

        loadTheme();
    })();
