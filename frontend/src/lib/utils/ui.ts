import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

type ElementRef = HTMLElement | SVGElement;

export type WithElementRef<T> = T & {
	ref?: ElementRef | null;
};

export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, "children"> : T;

export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, "child"> : T;

export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
