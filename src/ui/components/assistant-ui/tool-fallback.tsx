import {
  memo,
  useCallback,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ElementType,
  type FC,
  type PropsWithChildren,
} from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import {
  useScrollLock,
  useAuiState,
  type ToolCallMessagePartStatus,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const ANIMATION_DURATION = 200;

export type ToolFallbackRootProps = Omit<
  ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolFallbackRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        lockScroll();
      }
      if (!isControlled) {
        setUncontrolledOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange]
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-fallback-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "aui-tool-fallback-root group/tool-fallback-root w-full rounded-lg border py-3",
        className
      )}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as CSSProperties
      }
      {...props}
    >
      {children}
    </Collapsible>
  );
}

type ToolStatus = ToolCallMessagePartStatus["type"];

const statusIconMap: Record<ToolStatus, ElementType> = {
  running: LoaderIcon,
  complete: CheckIcon,
  incomplete: XCircleIcon,
  "requires-action": AlertCircleIcon,
};

function ToolFallbackTrigger({
  toolName,
  status,
  className,
  ...props
}: ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  status?: ToolCallMessagePartStatus;
}) {
  const statusType = (status?.type ?? "complete") as ToolStatus;
  const isRunning = statusType === "running";
  const isCancelled = status?.type === "incomplete" && status.reason === "cancelled";

  const Icon = statusIconMap[statusType];
  const label = isCancelled ? "Cancelled tool" : "Used tool";

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      className={cn(
        "aui-tool-fallback-trigger group/trigger flex w-full items-center gap-2 px-4 text-sm transition-colors",
        className
      )}
      {...props}
    >
      <Icon
        data-slot="tool-fallback-trigger-icon"
        className={cn(
          "aui-tool-fallback-trigger-icon size-4 shrink-0",
          isCancelled && "text-muted-foreground",
          isRunning && "animate-spin"
        )}
      />
      <span
        data-slot="tool-fallback-trigger-label"
        className={cn(
          "aui-tool-fallback-trigger-label-wrapper relative inline-block grow text-left leading-none",
          isCancelled && "text-muted-foreground line-through"
        )}
      >
        <span>
          {label}: <b>{toolName}</b>
        </span>
        {isRunning && (
          <span
            aria-hidden
            data-slot="tool-fallback-trigger-shimmer"
            className="aui-tool-fallback-trigger-shimmer shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
          >
            {label}: <b>{toolName}</b>
          </span>
        )}
      </span>
      <ChevronDownIcon
        data-slot="tool-fallback-trigger-chevron"
        className={cn(
          "aui-tool-fallback-trigger-chevron size-4 shrink-0",
          "transition-transform duration-(--animation-duration) ease-out",
          "group-data-[state=closed]/trigger:-rotate-90",
          "group-data-[state=open]/trigger:rotate-0"
        )}
      />
    </CollapsibleTrigger>
  );
}

function ToolFallbackContent({
  className,
  children,
  ...props
}: ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={cn(
        "aui-tool-fallback-content relative overflow-hidden text-sm outline-none",
        "group/collapsible-content ease-out",
        "data-[state=closed]:animate-collapsible-up",
        "data-[state=open]:animate-collapsible-down",
        "data-[state=closed]:fill-mode-forwards",
        "data-[state=closed]:pointer-events-none",
        "data-[state=open]:duration-(--animation-duration)",
        "data-[state=closed]:duration-(--animation-duration)",
        className
      )}
      {...props}
    >
      <div className="mt-3 flex flex-col gap-2 border-t pt-2">{children}</div>
    </CollapsibleContent>
  );
}

function ToolFallbackArgs({
  argsText,
  className,
  ...props
}: ComponentProps<"div"> & {
  argsText?: string;
}) {
  if (!argsText) return null;

  return (
    <div
      data-slot="tool-fallback-args"
      className={cn("aui-tool-fallback-args px-4", className)}
      {...props}
    >
      <pre className="aui-tool-fallback-args-value whitespace-pre-wrap">{argsText}</pre>
    </div>
  );
}

function ToolFallbackResult({
  result,
  className,
  ...props
}: ComponentProps<"div"> & {
  result?: unknown;
}) {
  if (result === undefined) return null;

  return (
    <div
      data-slot="tool-fallback-result"
      className={cn("aui-tool-fallback-result border-t border-dashed px-4 pt-2", className)}
      {...props}
    >
      <p className="aui-tool-fallback-result-header font-semibold">Result:</p>
      <pre className="aui-tool-fallback-result-content whitespace-pre-wrap">
        {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
      </pre>
    </div>
  );
}

function ToolFallbackError({
  status,
  isError,
  result,
  className,
  ...props
}: ComponentProps<"div"> & {
  status?: ToolCallMessagePartStatus;
  isError?: boolean;
  result?: unknown;
}) {
  const statusError =
    status?.type === "incomplete"
      ? status.error
        ? typeof status.error === "string"
          ? status.error
          : JSON.stringify(status.error)
        : undefined
      : undefined;

  const resultError =
    isError === true && result !== undefined
      ? typeof result === "string"
        ? result
        : JSON.stringify(result)
      : undefined;

  const errorText = statusError ?? resultError;
  if (!errorText) return null;

  const isCancelled = status?.type === "incomplete" && status.reason === "cancelled";
  const headerText = isCancelled ? "Cancelled reason:" : "Error:";

  return (
    <div
      data-slot="tool-fallback-error"
      className={cn("aui-tool-fallback-error px-4", className)}
      {...props}
    >
      <p className="aui-tool-fallback-error-header font-semibold text-muted-foreground">
        {headerText}
      </p>
      <p className="aui-tool-fallback-error-reason text-muted-foreground">{errorText}</p>
    </div>
  );
}

const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
  isError,
}) => {
  const isCancelled = status?.type === "incomplete" && status.reason === "cancelled";

  return (
    <ToolFallbackRoot
      defaultOpen
      className={cn(isCancelled && "border-muted-foreground/30 bg-muted/30")}
    >
      <ToolFallbackTrigger toolName={toolName} status={status} />
      <ToolFallbackContent>
        <ToolFallbackError status={status} isError={isError} result={result} />
        <ToolFallbackArgs argsText={argsText} className={cn(isCancelled && "opacity-60")} />
        {!isCancelled && <ToolFallbackResult result={result} />}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

const ToolFallback = memo(ToolFallbackImpl) as unknown as ToolCallMessagePartComponent & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Args: typeof ToolFallbackArgs;
  Result: typeof ToolFallbackResult;
  Error: typeof ToolFallbackError;
};

ToolFallback.displayName = "ToolFallback";
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.Error = ToolFallbackError;

// ---------------------------------------------------------------------------
// ToolGroup – outer collapsible wrapper for consecutive tool-call parts
// ---------------------------------------------------------------------------

function ToolGroupRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: Omit<ComponentProps<typeof Collapsible>, "open" | "onOpenChange"> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
}) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        lockScroll();
      }
      if (!isControlled) {
        setUncontrolledOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange]
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-group-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "aui-tool-group-root group/tool-group-root mb-4 w-full rounded-lg border px-3 py-2",
        className
      )}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as CSSProperties
      }
      {...props}
    >
      {children}
    </Collapsible>
  );
}

function ToolGroupTrigger({
  active,
  toolCount,
  className,
  ...props
}: ComponentProps<typeof CollapsibleTrigger> & {
  active?: boolean;
  toolCount: number;
}) {
  const label = `Used tools (${toolCount})`;

  return (
    <CollapsibleTrigger
      data-slot="tool-group-trigger"
      className={cn(
        "aui-tool-group-trigger group/trigger flex max-w-[75%] items-center gap-2 py-1 text-muted-foreground text-sm transition-colors hover:text-foreground",
        className
      )}
      {...props}
    >
      <WrenchIcon
        data-slot="tool-group-trigger-icon"
        className="aui-tool-group-trigger-icon size-4 shrink-0"
      />
      <span
        data-slot="tool-group-trigger-label"
        className="aui-tool-group-trigger-label-wrapper relative inline-block leading-none"
      >
        <span>{label}</span>
        {active ? (
          <span
            aria-hidden
            data-slot="tool-group-trigger-shimmer"
            className="aui-tool-group-trigger-shimmer shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
          >
            {label}
          </span>
        ) : null}
      </span>
      <ChevronDownIcon
        data-slot="tool-group-trigger-chevron"
        className={cn(
          "aui-tool-group-trigger-chevron mt-0.5 size-4 shrink-0",
          "transition-transform duration-(--animation-duration) ease-out",
          "group-data-[state=closed]/trigger:-rotate-90",
          "group-data-[state=open]/trigger:rotate-0"
        )}
      />
    </CollapsibleTrigger>
  );
}

function ToolGroupContent({
  className,
  children,
  ...props
}: ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-group-content"
      className={cn(
        "aui-tool-group-content relative overflow-hidden text-sm outline-none",
        "group/collapsible-content ease-out",
        "data-[state=closed]:animate-collapsible-up",
        "data-[state=open]:animate-collapsible-down",
        "data-[state=closed]:fill-mode-forwards",
        "data-[state=closed]:pointer-events-none",
        "data-[state=open]:duration-(--animation-duration)",
        "data-[state=closed]:duration-(--animation-duration)",
        className
      )}
      {...props}
    >
      <div className="flex flex-col gap-2 pt-2">{children}</div>
    </CollapsibleContent>
  );
}

const ToolGroupImpl: FC<PropsWithChildren<{ startIndex: number; endIndex: number }>> = ({
  children,
  startIndex,
  endIndex,
}) => {
  const toolCount = endIndex - startIndex + 1;

  const isToolRunning = useAuiState((s) => {
    if (s.message.status?.type !== "running") return false;
    const lastIndex = s.message.parts.length - 1;
    if (lastIndex < 0) return false;
    const lastType = s.message.parts[lastIndex]?.type;
    if (lastType !== "tool-call") return false;
    return lastIndex >= startIndex && lastIndex <= endIndex;
  });

  return (
    <ToolGroupRoot>
      <ToolGroupTrigger active={isToolRunning} toolCount={toolCount} />
      <ToolGroupContent aria-busy={isToolRunning}>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

const ToolGroup = memo(ToolGroupImpl);
ToolGroup.displayName = "ToolGroup";

export {
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackError,
  ToolGroup,
};
