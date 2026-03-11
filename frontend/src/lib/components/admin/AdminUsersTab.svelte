<script>
  import { createEventDispatcher, onMount } from 'svelte';

  import { t, translateNow } from '$lib/i18n/index';
  import { apiJson } from '$lib/services/http';
  import { formatUiDate } from '$lib/utils/edit-ui';

  export let isMasterAdmin = false;

  const dispatch = createEventDispatcher();
  const msg = (error, fallback) => String(error?.message || fallback);

  let users = [];
  let usersLoading = false;
  let usersStatus = translateNow('admin.loading');
  let usersQuery = '';
  let usersRole = 'all';
  let usersCanEdit = 'all';
  let usersHasEdits = 'all';
  let usersSortBy = 'createdAt';
  let usersSortDir = 'desc';

  async function loadUsers() {
    usersLoading = true;
    usersStatus = translateNow('admin.loading');

    try {
      const params = new URLSearchParams();
      if (String(usersQuery || '').trim()) params.set('q', String(usersQuery).trim());
      if (usersRole === 'admin' || usersRole === 'user') params.set('role', usersRole);
      if (usersCanEdit === 'yes') params.set('canEdit', 'true');
      if (usersCanEdit === 'no') params.set('canEdit', 'false');
      if (usersHasEdits === 'yes') params.set('hasEdits', 'true');
      if (usersHasEdits === 'no') params.set('hasEdits', 'false');
      params.set('sortBy', usersSortBy);
      params.set('sortDir', usersSortDir);

      const data = await apiJson(`/api/admin/users?${params.toString()}`);
      users = Array.isArray(data?.items) ? data.items : [];
      usersStatus = users.length
        ? translateNow('admin.users.found', { count: users.length })
        : translateNow('admin.empty');
    } catch (error) {
      users = [];
      usersStatus = msg(error, translateNow('admin.users.loadFailed'));
    } finally {
      usersLoading = false;
      dispatch('summary', { count: users.length });
    }
  }

  async function toggleCanEdit(user) {
    try {
      await apiJson('/api/admin/users/edit-permission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: String(user?.email || '')
            .trim()
            .toLowerCase(),
          canEdit: !Boolean(user?.canEdit)
        })
      });
      await loadUsers();
    } catch (error) {
      usersStatus = msg(error, translateNow('admin.users.permUpdateFailed'));
    }
  }

  async function toggleAdmin(user) {
    try {
      await apiJson('/api/admin/users/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: String(user?.email || '')
            .trim()
            .toLowerCase(),
          isAdmin: !Boolean(user?.isAdmin)
        })
      });
      await loadUsers();
    } catch (error) {
      usersStatus = msg(error, translateNow('admin.users.roleUpdateFailed'));
    }
  }

  onMount(() => {
    void loadUsers();
  });
</script>

<div class="mt-3 space-y-3">
  <form class="grid gap-2 lg:grid-cols-[1.4fr_repeat(4,minmax(0,1fr))]" on:submit|preventDefault={loadUsers}>
    <input class="ui-field" type="search" placeholder={$t('admin.users.search')} bind:value={usersQuery} />
    <select class="ui-field" bind:value={usersRole}
      ><option value="all">{$t('admin.users.roleAll')}</option><option value="admin"
        >{$t('admin.users.roleAdmins')}</option
      ><option value="user">{$t('admin.users.roleUsers')}</option></select
    >
    <select class="ui-field" bind:value={usersCanEdit}
      ><option value="all">{$t('admin.users.permAll')}</option><option value="yes"
        >{$t('admin.users.permYes')}</option
      ><option value="no">{$t('admin.users.permNo')}</option></select
    >
    <select class="ui-field" bind:value={usersHasEdits}
      ><option value="all">{$t('admin.users.editsAll')}</option><option value="yes"
        >{$t('admin.users.editsYes')}</option
      ><option value="no">{$t('admin.users.editsNo')}</option></select
    >
    <div class="flex gap-2">
      <select class="ui-field" bind:value={usersSortBy}
        ><option value="createdAt">{$t('admin.users.sortRegistered')}</option><option value="email"
          >{$t('admin.users.sortEmail')}</option
        ><option value="editsCount">{$t('admin.users.sortEditsCount')}</option><option value="lastEditAt"
          >{$t('admin.users.sortLastEdit')}</option
        ><option value="firstName">{$t('admin.users.sortFirstName')}</option><option value="lastName"
          >{$t('admin.users.sortLastName')}</option
        ></select
      ><select class="ui-field ui-field-xs" bind:value={usersSortDir}
        ><option value="desc">{$t('common.desc')}</option><option value="asc">{$t('common.asc')}</option></select
      ><button type="submit" class="ui-btn ui-btn-secondary">{$t('common.refresh')}</button>
    </div>
  </form>

  <p class="text-sm ui-text-muted">{usersStatus}</p>

  <div class="overflow-x-auto rounded-2xl border ui-border ui-surface-base">
    <table class="min-w-full text-sm">
      <thead>
        <tr class="border-b ui-border text-left ui-text-muted">
          <th class="px-3 py-2">{$t('admin.users.table.email')}</th>
          <th class="px-3 py-2">{$t('admin.users.table.role')}</th>
          <th class="px-3 py-2">{$t('admin.users.table.edits')}</th>
          <th class="px-3 py-2">{$t('admin.users.table.registration')}</th>
          <th class="px-3 py-2">{$t('admin.users.table.lastEdit')}</th>
          <th class="px-3 py-2">{$t('admin.users.table.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {#if usersLoading}
          <tr><td colspan="6" class="px-3 py-3 ui-text-subtle">{$t('admin.loading')}</td></tr>
        {:else if users.length === 0}
          <tr><td colspan="6" class="px-3 py-3 ui-text-subtle">{$t('admin.empty')}</td></tr>
        {:else}
          {#each users as user (`${user.email}`)}
            <tr class="border-b ui-border-soft">
              <td class="px-3 py-2">
                <p class="font-semibold ui-text-strong">{user.email}</p>
                {#if user.firstName || user.lastName}
                  <p class="text-xs ui-text-subtle">
                    {String(user.firstName || '').trim()}
                    {String(user.lastName || '').trim()}
                  </p>
                {/if}
              </td>
              <td class="px-3 py-2">
                {#if user.isMasterAdmin}
                  <span
                    class="badge-pill mr-1 rounded-full ui-surface-warning px-2.5 py-1 text-xs font-semibold ui-text-warning"
                    >{$t('admin.users.masterAdmin')}</span
                  >
                {/if}
                <span
                  class="badge-pill mr-1 rounded-full px-2.5 py-1 text-xs font-semibold {user.isAdmin
                    ? 'ui-surface-emphasis ui-text-emphasis'
                    : 'ui-surface-soft ui-text-body'}"
                  >{user.isAdmin ? $t('admin.users.admin') : $t('admin.users.user')}</span
                >
                <span
                  class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {user.canEdit
                    ? 'ui-surface-success ui-text-success'
                    : 'ui-surface-soft ui-text-body'}"
                  >{user.canEdit ? $t('admin.users.canEdit') : $t('admin.users.readOnly')}</span
                >
              </td>
              <td class="px-3 py-2">{user.editsCount || 0}</td>
              <td class="px-3 py-2">{formatUiDate(user.createdAt)}</td>
              <td class="px-3 py-2">{formatUiDate(user.lastEditAt)}</td>
              <td class="px-3 py-2">
                <button type="button" class="ui-btn ui-btn-secondary ui-btn-xs" on:click={() => toggleCanEdit(user)}
                  >{user.canEdit ? $t('admin.users.disableEdit') : $t('admin.users.enableEdit')}</button
                >
                <button
                  type="button"
                  class="ui-btn ui-btn-secondary ui-btn-xs"
                  on:click={() => toggleAdmin(user)}
                  disabled={!isMasterAdmin || Boolean(user.isMasterAdmin)}
                  >{user.isAdmin ? $t('admin.users.demoteAdmin') : $t('admin.users.promoteAdmin')}</button
                >
              </td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
</div>
