(function initArchiMapAdminUsers() {
  function buildUserViewModel(item, currentAdminEmail) {
    const email = String(item?.email || '').trim().toLowerCase();
    const firstName = String(item?.firstName || '').trim();
    const lastName = String(item?.lastName || '').trim();
    const displayName = [firstName, lastName].filter(Boolean).join(' ') || email;
    const isAdmin = Boolean(item?.isAdmin);
    const isMasterAdminAccount = Boolean(item?.isMasterAdmin);
    const isCurrentUser = Boolean(currentAdminEmail) && email === String(currentAdminEmail).trim().toLowerCase();
    const isSelfMasterAdminDemotionLocked = isAdmin && isMasterAdminAccount && isCurrentUser;
    const canEdit = Boolean(item?.canEdit);
    const editsCount = Number(item?.editsCount || 0);
    const createdAt = String(item?.createdAt || '').replace('T', ' ').replace('Z', '');

    return {
      email,
      displayName,
      isAdmin,
      isMasterAdminAccount,
      isSelfMasterAdminDemotionLocked,
      canEdit,
      editsCount,
      createdAt
    };
  }

  window.ArchiMapAdminUsers = {
    buildUserViewModel
  };
})();
