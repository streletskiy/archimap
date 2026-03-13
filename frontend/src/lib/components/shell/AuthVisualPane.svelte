<script>
  export let imageUrl = '';

  $: authVisualImage = imageUrl ? `url("${imageUrl}")` : 'none';
</script>

<div class="bg-muted relative hidden md:block" aria-hidden="true">
  <div class="auth-visual-fill" style={`--auth-visual-image: ${authVisualImage};`}></div>
</div>

<style>
  .auth-visual-fill {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background:
      radial-gradient(circle at 16% 18%, color-mix(in srgb, var(--accent-soft) 72%, transparent) 0%, transparent 34%),
      radial-gradient(circle at 84% 22%, rgba(255, 255, 255, 0.18) 0%, transparent 22%),
      linear-gradient(145deg, color-mix(in srgb, var(--panel-solid) 84%, transparent) 0%, rgba(8, 17, 31, 0.12) 100%);
  }

  .auth-visual-fill::before,
  .auth-visual-fill::after {
    content: '';
    position: absolute;
    inset: -10%;
  }

  .auth-visual-fill::before {
    background:
      var(--auth-visual-image) center / cover no-repeat,
      repeating-linear-gradient(90deg, transparent 0 2.15rem, rgba(255, 255, 255, 0.08) 2.15rem 2.23rem),
      repeating-linear-gradient(0deg, transparent 0 2.15rem, rgba(255, 255, 255, 0.06) 2.15rem 2.23rem),
      linear-gradient(128deg, transparent 10%, rgba(255, 255, 255, 0.12) 10.8%, transparent 11.6%),
      linear-gradient(34deg, transparent 31%, rgba(255, 255, 255, 0.12) 31.8%, transparent 32.6%),
      linear-gradient(168deg, transparent 58%, rgba(255, 255, 255, 0.08) 58.8%, transparent 59.6%);
    filter: blur(5px);
    opacity: 0.7;
    transform: scale(1.04);
  }

  .auth-visual-fill::after {
    background:
      radial-gradient(circle at 22% 74%, rgba(253, 200, 47, 0.18) 0%, transparent 14%),
      radial-gradient(circle at 72% 64%, rgba(253, 200, 47, 0.14) 0%, transparent 12%),
      radial-gradient(circle at 42% 46%, rgba(255, 255, 255, 0.12) 0%, transparent 14%);
    filter: blur(24px);
    opacity: 0.84;
  }
</style>
