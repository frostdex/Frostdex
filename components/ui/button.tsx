import type { ButtonHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  size?: "default" | "small";
};

const variants: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "bg-ink text-white hover:bg-[#30362d] disabled:cursor-not-allowed disabled:opacity-50",
  secondary: "border border-black/10 bg-white text-ink hover:bg-[#f4f4ef] disabled:opacity-50",
  ghost: "text-muted hover:bg-black/5 hover:text-ink",
};

export function Button({
  className = "",
  variant = "primary",
  size = "default",
  ...props
}: ButtonProps) {
  const dimensions = size === "small" ? "min-h-9 px-3 text-sm" : "min-h-12 px-5";
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors ${dimensions} ${variants[variant]} ${className}`}
      {...props}
    />
  );
}
