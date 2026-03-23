<script>
  export let imageUrl = '';
</script>

<div class="bg-muted relative hidden md:block" aria-hidden="true">
  <div class="auth-visual-fill">
    {#if imageUrl}
      <img class="auth-visual-image" src={imageUrl} alt="" loading="lazy" decoding="async" />
    {/if}
  </div>
</div>

<style>
  .auth-visual-fill {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background:
      radial-gradient(circle at 18% 20%, color-mix(in srgb, var(--accent) 16%, var(--panel-solid)) 0%, transparent 30%),
      radial-gradient(circle at 84% 24%, color-mix(in srgb, var(--panel-border-strong) 26%, var(--panel-solid)) 0%, transparent 24%),
      linear-gradient(145deg, var(--panel-solid) 0%, var(--bg-muted) 100%);
  }

  .auth-visual-image {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center;
  }

  .auth-visual-fill::before,
  .auth-visual-fill::after {
    content: '';
    position: absolute;
    inset: -10%;
  }

  .auth-visual-fill::before {
    background:
      repeating-linear-gradient(90deg, transparent 0 2.15rem, color-mix(in srgb, var(--panel-border-strong) 18%, transparent) 2.15rem 2.23rem),
      repeating-linear-gradient(0deg, transparent 0 2.15rem, color-mix(in srgb, var(--panel-border-strong) 12%, transparent) 2.15rem 2.23rem),
      linear-gradient(128deg, transparent 10%, color-mix(in srgb, var(--accent) 10%, transparent) 10.8%, transparent 11.6%),
      linear-gradient(34deg, transparent 31%, color-mix(in srgb, var(--panel-border-strong) 12%, transparent) 31.8%, transparent 32.6%),
      linear-gradient(168deg, transparent 58%, color-mix(in srgb, var(--accent) 8%, transparent) 58.8%, transparent 59.6%);
    opacity: 0.5;
    transform: scale(1.04);
  }

  .auth-visual-fill::after {
    background:
      radial-gradient(circle at 22% 74%, color-mix(in srgb, var(--accent) 16%, var(--panel-solid)) 0%, transparent 14%),
      radial-gradient(circle at 72% 64%, color-mix(in srgb, var(--accent) 12%, var(--panel-solid)) 0%, transparent 12%),
      radial-gradient(circle at 42% 46%, color-mix(in srgb, var(--panel-border-strong) 18%, var(--panel-solid)) 0%, transparent 14%);
    opacity: 0.72;
  }
</style>
