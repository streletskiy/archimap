<script lang="ts">
	import { RangeCalendar as RangeCalendarPrimitive } from "bits-ui";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils/ui.js";
	import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";

	let {
		ref = $bindable(null),
		class: className,
		value,
		onchange,
		...restProps
	}: WithoutChildrenOrChild<RangeCalendarPrimitive.MonthSelectProps> = $props();
</script>

<span
	class={cn("ui-calendar-select-shell", className)}
>
	<RangeCalendarPrimitive.MonthSelect bind:ref class="absolute inset-0 opacity-0" {...restProps}>
		{#snippet child({ props, monthItems, selectedMonthItem })}
			<select {...props} {value} {onchange}>
				{#each monthItems as monthItem (monthItem.value)}
					<option
						value={monthItem.value}
						selected={value !== undefined
							? monthItem.value === value
							: monthItem.value === selectedMonthItem.value}
					>
						{monthItem.label}
					</option>
				{/each}
			</select>
			<span
				class="ui-calendar-select-value"
				aria-hidden="true"
			>
				{monthItems.find((item) => item.value === value)?.label || selectedMonthItem.label}
				<ChevronDownIcon class="size-4" />
			</span>
		{/snippet}
	</RangeCalendarPrimitive.MonthSelect>
</span>
