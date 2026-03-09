<script>
  export let label = '';
  export let forId = '';
  export let note = '';
</script>

<div class="form-row">
  {#if label}
    <label for={forId}>{label}</label>
  {/if}
  {#if note}
    <p class="form-row-note">{note}</p>
  {/if}
  <slot />
</div>

<style>
  .form-row {
    display: grid;
    gap: 0.38rem;
  }

  .form-row > label {
    font-size: 0.76rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }

  .form-row-note {
    margin: -0.15rem 0 0.1rem;
    color: var(--muted);
    font-size: 0.84rem;
    line-height: 1.45;
  }
</style>
