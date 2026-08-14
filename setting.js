(function () {
    // 脚本在 body 末尾执行，DOM 已就绪。
    // 主进程在 URL 中带 theme 参数：同步应用主题，避免打开时闪深色。
    const themeFromUrl = new URLSearchParams(location.search).get('theme');
    if (themeFromUrl === 'light' || themeFromUrl === 'dark') {
        applyAppTheme(themeFromUrl);
    }
    window.editorAPI.loadSettings()
        .then((data) => {
            applyAppTheme((data && data.editor && data.editor.theme) || 'dark');
        })
        .catch(() => {});

    const closeBtn = document.getElementById('close-btn');
    const navItems = document.querySelectorAll('.settings-nav .nav-item');
    const panels = document.querySelectorAll('.settings-panel');

    // 默认设置：作为表单回填的兜底；尚未接入应用实际行为（先不写应用设置部分）。
    const DEFAULTS = {
        editor: {
            fontSize: 14,
            fileTreeFontSize: 14,
            theme: 'dark',
            autoClosingBrackets: true,
            autoClosingQuotes: true,
            bracketPairColorization: true,
            matchBrackets: true,
            autoIndent: true,
        },
        compile: {
            compilerCommand: '',
            linkerCommand: '-static-libgcc',
            languageStandardCpp: 'c++17',
            languageStandardC: 'c11',
            warningLevel: 2,
        },
        templates: {
            cpp: '',
            c: '',
            header: '#ifndef _{FILE_NAME}_H_\n#define _{FILE_NAME}_H_\n\n\n#endif',
        },
        shortcuts: {
            newFile: 'Ctrl+N',
            saveFile: 'Ctrl+S',
            compileRun: 'F5',
            jumpToDefinition: 'Ctrl+单击',
            findText: 'Ctrl+F',
            nextTab: 'Ctrl+Tab',
            closeTab: 'Ctrl+W',
        },
    };

    // 输入控件 id → 设置路径（分组、键名）映射
    const FIELD_MAP = [
        ['compileCommand', 'compile', 'compilerCommand'],
        ['linkCommand', 'compile', 'linkerCommand'],
        ['languageStandardCpp', 'compile', 'languageStandardCpp'],
        ['languageStandardC', 'compile', 'languageStandardC'],
        ['warningLevel', 'compile', 'warningLevel'],
        ['fontSize', 'editor', 'fontSize'],
        ['fileTreeFontSize', 'editor', 'fileTreeFontSize'],
        ['themeMode', 'editor', 'theme'],
        ['autoClosingBrackets', 'editor', 'autoClosingBrackets'],
        ['autoClosingQuotes', 'editor', 'autoClosingQuotes'],
        ['bracketPairColorization', 'editor', 'bracketPairColorization'],
        ['matchBrackets', 'editor', 'matchBrackets'],
        ['autoIndent', 'editor', 'autoIndent'],
        ['templateCpp', 'templates', 'cpp'],
        ['templateC', 'templates', 'c'],
        ['templateHeader', 'templates', 'header'],
        ['shortcutNewFile', 'shortcuts', 'newFile'],
        ['shortcutSaveFile', 'shortcuts', 'saveFile'],
        ['shortcutCompileRun', 'shortcuts', 'compileRun'],
        ['shortcutJumpDefinition', 'shortcuts', 'jumpToDefinition'],
        ['shortcutFindText', 'shortcuts', 'findText'],
        ['shortcutNextTab', 'shortcuts', 'nextTab'],
        ['shortcutCloseTab', 'shortcuts', 'closeTab'],
    ];

    let settings = {};

    function getField(id) {
        return document.getElementById(id);
    }

    function fieldValue(el) {
        if (el.type === 'checkbox') return el.checked;
        if (el.type === 'number') return Number(el.value);
        return el.value;
    }

    function setFieldValue(el, value) {
        if (el.type === 'checkbox') el.checked = !!value;
        else el.value = value == null ? '' : String(value);
    }

    // 用「已保存设置 ∪ 默认值」回填表单
    function fillForm(data) {
        settings = { ...data };
        for (const [id, group, key] of FIELD_MAP) {
            const el = getField(id);
            let value;
            if (settings[group] && settings[group][key] !== undefined) value = settings[group][key];
            else if (DEFAULTS[group] && DEFAULTS[group][key] !== undefined) value = DEFAULTS[group][key];
            setFieldValue(el, value);
        }
    }

    // 从表单收集设置并持久化
    function collectAndSave() {
        for (const [id, group, key] of FIELD_MAP) {
            if (!settings[group]) settings[group] = {};
            settings[group][key] = fieldValue(getField(id));
        }
        window.editorAPI.saveSettings(settings);
    }

    // 设置窗口自身随主题切换深浅色，并切换浅色版图标
    function applyAppTheme(theme) {
        const light = theme === 'light';
        document.body.classList.toggle('theme-light', light);
        document.querySelectorAll('img[data-light-src]').forEach((img) => {
            img.src = light ? img.dataset.lightSrc : img.dataset.darkSrc;
        });
    }

    // 切换导航：显示对应分组面板
    function switchPanel(name) {
        navItems.forEach(item => {
            item.classList.toggle('active', item.dataset.panel === name);
        });
        panels.forEach(panel => {
            panel.classList.toggle('active', panel.dataset.panel === name);
        });
    }

    closeBtn.addEventListener('click', () => {
        window.editorAPI.closeSettingWindow();
    });

    navItems.forEach(item => {
        item.addEventListener('click', () => switchPanel(item.dataset.panel));
    });

    // 任一控件变化立即保存
    document.querySelectorAll('.settings-panel input, .settings-panel select, .settings-panel textarea').forEach(el => {
        el.addEventListener('change', collectAndSave);
    });

    // 读取已保存设置后回填；读取失败时也按默认值回填
    window.editorAPI.loadSettings()
        .then(data => {
            fillForm(data || {});
            applyAppTheme((data && data.editor && data.editor.theme) || 'dark');
        })
        .catch(() => {
            fillForm({});
            applyAppTheme('dark');
        });

    // 切换配色主题时，设置窗口自身即时预览对应配色
    getField('themeMode').addEventListener('change', () => {
        applyAppTheme(getField('themeMode').value);
    });
})();
