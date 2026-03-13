<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils/ui.js";
	import type { HTMLTdAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLTdAttributes> = $props();
</script>

<td
	bind:this={ref}
	data-slot="table-cell"
	class={cn("ui-table-cell", className)}
	{...restProps}
>
	{@render children?.()}
</td>
