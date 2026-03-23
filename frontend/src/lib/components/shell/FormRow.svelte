<script>
  import { UiLabel } from '$lib/components/base';

  export let label = '';
  export let forId = '';
  export let note = '';
</script>

<div class="form-row">
  {#if label}
    <UiLabel className="text-[0.76rem] uppercase tracking-[0.08em] ui-text-muted" for={forId}>{label}</UiLabel>
  {/if}
  {#if note}
    <p class="form-row-note">{note}</p>
  {/if}
  <slot />
</div>

<style>
  .form-row {
    display: grid;
    gap: 0.375rem;
  }

  .form-row-note {
    margin: 0;
    color: var(--muted);
    font-size: 0.84rem;
    line-height: 1.45;
  }
</style>
