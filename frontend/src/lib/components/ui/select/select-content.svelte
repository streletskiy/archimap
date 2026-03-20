<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import SelectPortal from "./select-portal.svelte";
	import SelectScrollUpButton from "./select-scroll-up-button.svelte";
	import SelectScrollDownButton from "./select-scroll-down-button.svelte";
	import { cn, type WithoutChild } from "$lib/utils/ui.js";
	import type { ComponentProps } from "svelte";
	import type { WithoutChildrenOrChild } from "$lib/utils/ui.js";

	let {
		ref = $bindable(null),
		class: className,
		sideOffset = 4,
		portalProps,
		children,
		preventScroll = false,
		...restProps
	}: WithoutChild<SelectPrimitive.ContentProps> & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof SelectPortal>>;
	} = $props();
</script>

<SelectPortal {...portalProps}>
	<SelectPrimitive.Content
		bind:ref
		{sideOffset}
		{preventScroll}
		data-slot="select-content"
		class={cn("ui-select-content", className)}
		{...restProps}
	>
		<SelectScrollUpButton />
		<SelectPrimitive.Viewport class={cn("ui-select-viewport")}>
			{@render children?.()}
		</SelectPrimitive.Viewport>
		<SelectScrollDownButton />
	</SelectPrimitive.Content>
</SelectPortal>
