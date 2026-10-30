(() => {
  const status = document.getElementById("status");
  const hint = document.getElementById("hint");

  window.showError = (message) => {
    if (status) status.textContent = String(message || "启动失败");
    if (hint) {
      hint.textContent =
        "请查看 %APPDATA%\\llmapi-manager\\log\\desktop-server.log，修复后重新启动应用。";
    }
    document.body.classList.add("error");
  };
})();
