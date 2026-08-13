document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('close-btn').addEventListener('click', () => {
        window.editorAPI.closeSettingWindow();
    })
});