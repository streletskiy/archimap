<script lang="ts">
	import type { HTMLTableAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from "$lib/utils/ui.js";

	let {
		ref = $bindable(null),
		class: className,
		containerClass: containerClassName,
		children,
		...restProps
	}: WithElementRef<HTMLTableAttributes> & {
		containerClass?: string;
	} = $props();
</script>

<div data-slot="table-container" class={cn("ui-table-container", containerClassName)}>
	<table
		bind:this={ref}
		data-slot="table"
		class={cn("ui-table", className)}
		{...restProps}
	>
		{@render children?.()}
	</table>
</div>
