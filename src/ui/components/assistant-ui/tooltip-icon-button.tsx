import React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Button, type ButtonProps } from "../ui/button.js";
import { cn } from "../../lib/utils.js";

type TooltipIconButtonProps = ButtonProps & {
  tooltip: string;
  side?: "top" | "bottom" | "left" | "right";
};

export const TooltipIconButton = React.forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  ({ children, tooltip, side = "top", className, ...props }, ref) => {
    return (
      <TooltipPrimitive.Provider>
        <TooltipPrimitive.Root>
          <TooltipPrimitive.Trigger asChild>
            <Button
              variant="ghost"
              size="icon"
              ref={ref}
              className={cn("size-8 [&_svg]:size-4", className)}
              {...props}
            >
              {children}
              <span className="sr-only">{tooltip}</span>
            </Button>
          </TooltipPrimitive.Trigger>
          <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
              side={side}
              sideOffset={4}
              className="z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95"
            >
              {tooltip}
            </TooltipPrimitive.Content>
          </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>
      </TooltipPrimitive.Provider>
    );
  }
);
TooltipIconButton.displayName = "TooltipIconButton";
