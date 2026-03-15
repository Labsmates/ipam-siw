(function () {
  // Block right-click context menu
  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    return false;
  });

  // Block keyboard shortcuts for devtools / view-source
  document.addEventListener('keydown', function (e) {
    // F12
    if (e.key === 'F12') { e.preventDefault(); return false; }
    // Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C (DevTools)
    if (e.ctrlKey && e.shiftKey && ['I','i','J','j','C','c'].includes(e.key)) {
      e.preventDefault(); return false;
    }
    // Ctrl+U (view source)
    if (e.ctrlKey && (e.key === 'U' || e.key === 'u')) {
      e.preventDefault(); return false;
    }
    // Ctrl+S (save page)
    if (e.ctrlKey && (e.key === 'S' || e.key === 's')) {
      e.preventDefault(); return false;
    }
  });
})();
