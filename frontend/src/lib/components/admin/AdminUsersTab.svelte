<script>
  import { createEventDispatcher, onMount } from 'svelte';

  import {
    UiBadge,
    UiButton,
    UiInput,
    UiSelect,
    UiTable,
    UiTableBody,
    UiTableCell,
    UiTableHead,
    UiTableHeader,
    UiTableRow
  } from '$lib/components/base';
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
  let usersRoleItems = [];
  let usersCanEditItems = [];
  let usersHasEditsItems = [];
  let usersSortByItems = [];
  let usersSortDirItems = [];

  $: usersRoleItems = [
    { value: 'all', label: $t('admin.users.roleAll') },
    { value: 'admin', label: $t('admin.users.roleAdmins') },
    { value: 'user', label: $t('admin.users.roleUsers') }
  ];
  $: usersCanEditItems = [
    { value: 'all', label: $t('admin.users.permAll') },
    { value: 'yes', label: $t('admin.users.permYes') },
    { value: 'no', label: $t('admin.users.permNo') }
  ];
  $: usersHasEditsItems = [
    { value: 'all', label: $t('admin.users.editsAll') },
    { value: 'yes', label: $t('admin.users.editsYes') },
    { value: 'no', label: $t('admin.users.editsNo') }
  ];
  $: usersSortByItems = [
    { value: 'createdAt', label: $t('admin.users.sortRegistered') },
    { value: 'email', label: $t('admin.users.sortEmail') },
    { value: 'editsCount', label: $t('admin.users.sortEditsCount') },
    { value: 'lastEditAt', label: $t('admin.users.sortLastEdit') },
    { value: 'firstName', label: $t('admin.users.sortFirstName') },
    { value: 'lastName', label: $t('admin.users.sortLastName') }
  ];
  $: usersSortDirItems = [
    { value: 'desc', label: $t('common.desc') },
    { value: 'asc', label: $t('common.asc') }
  ];

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

<div class="mt-3 flex flex-col space-y-3 min-h-0 overflow-hidden">
  <form class="ui-filter-toolbar ui-filter-toolbar--admin-users" on:submit|preventDefault={loadUsers}>
    <UiInput type="search" placeholder={$t('admin.users.search')} bind:value={usersQuery} />
    <UiSelect items={usersRoleItems} bind:value={usersRole} />
    <UiSelect items={usersCanEditItems} bind:value={usersCanEdit} />
    <UiSelect items={usersHasEditsItems} bind:value={usersHasEdits} />
    <div class="ui-filter-toolbar__group sm:grid-cols-[minmax(0,1fr)_auto]">
      <div class="sm:col-span-2">
        <UiSelect items={usersSortByItems} bind:value={usersSortBy} />
      </div>
      <UiSelect items={usersSortDirItems} bind:value={usersSortDir} />
      <UiButton
        type="submit"
        variant="secondary"
        className="w-full min-h-11 rounded-[1rem] px-4 py-3 text-sm sm:w-auto"
      >
        {$t('common.refresh')}
      </UiButton>
    </div>
  </form>

  <p class="text-sm ui-text-muted">{usersStatus}</p>

  <UiScrollArea className="flex-1 min-h-0 rounded-2xl border ui-border">
    <UiTable containerClassName="ui-surface-base">
    <UiTableHeader>
      <UiTableRow className="hover:[&>th]:bg-transparent">
        <UiTableHead>{$t('admin.users.table.email')}</UiTableHead>
        <UiTableHead>{$t('admin.users.table.role')}</UiTableHead>
        <UiTableHead>{$t('admin.users.table.edits')}</UiTableHead>
        <UiTableHead>{$t('admin.users.table.registration')}</UiTableHead>
        <UiTableHead>{$t('admin.users.table.lastEdit')}</UiTableHead>
        <UiTableHead>{$t('admin.users.table.actions')}</UiTableHead>
      </UiTableRow>
    </UiTableHeader>
    <UiTableBody>
      {#if usersLoading}
        <UiTableRow>
          <UiTableCell colspan="6" className="ui-text-subtle">{$t('admin.loading')}</UiTableCell>
        </UiTableRow>
      {:else if users.length === 0}
        <UiTableRow>
          <UiTableCell colspan="6" className="ui-text-subtle">{$t('admin.empty')}</UiTableCell>
        </UiTableRow>
      {:else}
        {#each users as user (`${user.email}`)}
          <UiTableRow>
            <UiTableCell className="min-w-0">
              <p class="font-semibold ui-text-strong break-all line-clamp-1">{user.email}</p>
              {#if user.firstName || user.lastName}
                <p class="text-xs ui-text-subtle">
                  {String(user.firstName || '').trim()}
                  {String(user.lastName || '').trim()}
                </p>
              {/if}
            </UiTableCell>
            <UiTableCell>
              <div class="flex flex-wrap gap-1">
                {#if user.isMasterAdmin}
                  <UiBadge variant="warning">{$t('admin.users.masterAdmin')}</UiBadge>
                {/if}
                <UiBadge variant={user.isAdmin ? 'accent' : 'default'}>
                  {user.isAdmin ? $t('admin.users.admin') : $t('admin.users.user')}
                </UiBadge>
                <UiBadge variant={user.canEdit ? 'success' : 'default'}>
                  {user.canEdit ? $t('admin.users.canEdit') : $t('admin.users.readOnly')}
                </UiBadge>
              </div>
            </UiTableCell>
            <UiTableCell>{user.editsCount || 0}</UiTableCell>
            <UiTableCell>{formatUiDate(user.createdAt)}</UiTableCell>
            <UiTableCell>{formatUiDate(user.lastEditAt)}</UiTableCell>
            <UiTableCell>
              <div class="flex flex-wrap gap-2">
                <UiButton type="button" variant="secondary" size="xs" onclick={() => toggleCanEdit(user)}>
                  {user.canEdit ? $t('admin.users.disableEdit') : $t('admin.users.enableEdit')}
                </UiButton>
                <UiButton
                  type="button"
                  variant="secondary"
                  size="xs"
                  onclick={() => toggleAdmin(user)}
                  disabled={!isMasterAdmin || Boolean(user.isMasterAdmin)}
                >
                  {user.isAdmin ? $t('admin.users.demoteAdmin') : $t('admin.users.promoteAdmin')}
                </UiButton>
              </div>
            </UiTableCell>
          </UiTableRow>
        {/each}
      {/if}
    </UiTableBody>
    </UiTable>
  </UiScrollArea>
</div>
