(function initArchiMapMainAuth() {
  function readResetTokenFromUrl() {
    try {
      const url = new URL(window.location.href);
      const token = String(url.searchParams.get('resetToken') || '').trim();
      return token || null;
    } catch {
      return null;
    }
  }

  function readRegisterTokenFromUrl() {
    try {
      const url = new URL(window.location.href);
      const token = String(url.searchParams.get('registerToken') || '').trim();
      return token || null;
    } catch {
      return null;
    }
  }

  function clearResetTokenFromUrl() {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('resetToken')) return;
      url.searchParams.delete('resetToken');
      history.replaceState(null, '', url.toString());
    } catch {
      // ignore
    }
  }

  function clearRegisterTokenFromUrl() {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('registerToken')) return;
      url.searchParams.delete('registerToken');
      history.replaceState(null, '', url.toString());
    } catch {
      // ignore
    }
  }

  window.ArchiMapMainAuth = {
    readResetTokenFromUrl,
    readRegisterTokenFromUrl,
    clearResetTokenFromUrl,
    clearRegisterTokenFromUrl
  };
})();
