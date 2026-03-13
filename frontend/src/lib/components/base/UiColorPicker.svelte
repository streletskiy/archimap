<script>
  import { createEventDispatcher } from 'svelte';
  import ColorPicker, { ChromeVariant } from 'svelte-awesome-color-picker';
  import * as Popover from '$lib/components/ui/popover';
  import { cn } from '$lib/utils/ui.js';
  import UiInput from './UiInput.svelte';

  const HEX_COLOR_RE = /^#?[0-9a-f]{6}$/i;

  export let value = '#000000';
  export let label = 'Color';
  export let disabled = false;
  export let className = '';
  export let triggerClassName = '';
  export let contentClassName = '';
  export let swatches = [];
  export let name = undefined;
  export let onchange = undefined;

  const dispatch = createEventDispatcher();

  let open = false;
  let currentHex = normalizeHexColor(value, '#000000');
  let hexInputValue = currentHex;

  function normalizeHexColor(rawColor, fallback = '') {
    let color = String(rawColor || '').trim();
    if (color && !color.startsWith('#')) {
      color = `#${color}`;
    }
    if (HEX_COLOR_RE.test(color)) {
      return color.toLowerCase();
    }
    return fallback;
  }

  function emitChange(nextHex) {
    const detail = { value: nextHex, hex: nextHex };
    onchange?.({ detail });
    dispatch('change', detail);
  }

  function commitColor(rawColor) {
    const nextHex = normalizeHexColor(rawColor, currentHex || '#000000');
    if (!nextHex) return;
    hexInputValue = nextHex;
    if (nextHex === currentHex && nextHex === normalizeHexColor(value, currentHex)) {
      return;
    }
    currentHex = nextHex;
    value = nextHex;
    emitChange(nextHex);
  }

  function handlePickerInput(nextColor) {
    if (!nextColor?.hex) return;
    commitColor(nextColor.hex);
  }

  function handleHexInput(event) {
    hexInputValue = event.currentTarget.value;
    const nextHex = normalizeHexColor(hexInputValue, '');
    if (nextHex) {
      commitColor(nextHex);
    }
  }

  function handleHexBlur() {
    hexInputValue = currentHex;
  }

  function handleHexKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      hexInputValue = currentHex;
      open = false;
      event.currentTarget.blur();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commitColor(hexInputValue);
    event.currentTarget.blur();
  }

  $: {
    const normalizedValue = normalizeHexColor(value, currentHex || '#000000');
    if (normalizedValue && normalizedValue !== currentHex) {
      currentHex = normalizedValue;
      hexInputValue = normalizedValue;
    }
  }
</script>

<div class={cn('ui-color-picker', className)}>
  <Popover.Root bind:open>
    <Popover.Trigger
      disabled={disabled}
      aria-label={label}
      title={currentHex}
      class={cn('ui-color-picker-trigger', triggerClassName)}
    >
      <span
        class="ui-color-picker-trigger-swatch"
        aria-hidden="true"
        style:--ui-color-picker-swatch={currentHex}
      ></span>
      <span class="sr-only">{label}: {currentHex}</span>
    </Popover.Trigger>

    <Popover.Content
      sideOffset={8}
      align="start"
      class={cn('ui-color-picker-content', contentClassName)}
    >
      <div class="ui-color-picker-header" style:--ui-color-picker-swatch={currentHex}>
        <div class="ui-color-picker-preview">
          <span class="ui-color-picker-preview-swatch" aria-hidden="true"></span>
          <div class="ui-color-picker-preview-copy">
            <span class="ui-color-picker-label">{label}</span>
            <strong class="ui-color-picker-value">{currentHex}</strong>
          </div>
        </div>
      </div>

      <div class="ui-color-picker-shell">
        <ColorPicker
          components={ChromeVariant}
          {name}
          hex={currentHex}
          isDialog={false}
          isTextInput={false}
          isAlpha={false}
          sliderDirection="horizontal"
          {swatches}
          onInput={handlePickerInput}
        />
      </div>

      <div class="ui-color-picker-field">
        <UiInput
          bind:value={hexInputValue}
          size="xs"
          className="ui-color-picker-input"
          inputmode="text"
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          oninput={handleHexInput}
          onblur={handleHexBlur}
          onkeydown={handleHexKeydown}
        />
      </div>
    </Popover.Content>
  </Popover.Root>
</div>
