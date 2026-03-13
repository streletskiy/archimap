<script lang="ts" module>
	import { cn, type WithElementRef } from "$lib/utils/ui.js";
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";
	import { type VariantProps, tv } from "tailwind-variants";

	export const buttonVariants = tv({
		base: "ui-button",
		variants: {
			variant: {
				default: "ui-button--default",
				destructive: "ui-button--destructive",
				outline: "ui-button--outline",
				secondary: "ui-button--secondary",
				ghost: "ui-button--ghost",
				link: "ui-button--link",
			},
			size: {
				default: "ui-button--size-default",
				sm: "ui-button--size-sm",
				lg: "ui-button--size-lg",
				icon: "ui-button--size-icon",
				"icon-sm": "ui-button--size-icon-sm",
				"icon-lg": "ui-button--size-icon-lg",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
	export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = "default",
		size = "default",
		ref = $bindable(null),
		href = undefined,
		type = "button",
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? "link" : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
