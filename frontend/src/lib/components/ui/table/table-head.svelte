<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils/ui.js";
	import type { HTMLThAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLThAttributes> = $props();
</script>

<th
	bind:this={ref}
	data-slot="table-head"
	class={cn("ui-table-head", className)}
	{...restProps}
>
	{@render children?.()}
</th>
