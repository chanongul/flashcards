"use client";

import { Star, Ban, Copy, FolderInput, Trash2 } from "lucide-react";
import { Checkbox } from "./Checkbox";

interface BulkActionBarProps {
  count: number;
  allSelected: boolean;
  onToggleSelectAll: () => void;
  flagLabel: "Flag" | "Unflag";
  onFlag: () => void;
  suspendLabel: "Suspend" | "Unsuspend";
  onSuspend: () => void;
  onDuplicate: () => void;
  onMove: () => void;
  onDelete: () => void;
}

// Fixed bottom bar shown while a card list is in select mode — one bulk
// equivalent per per-row action CardRow's own dropdown offers, except
// info/edit, which only ever make sense for one card at a time. Flag/
// suspend read as a single toggle (flagLabel/suspendLabel), computed by the
// caller from whatever's currently selected — same "act as one group"
// convention Star/Ban already use per-row.
export function BulkActionBar({
  count,
  allSelected,
  onToggleSelectAll,
  flagLabel,
  onFlag,
  suspendLabel,
  onSuspend,
  onDuplicate,
  onMove,
  onDelete,
}: BulkActionBarProps) {
  const disabled = count === 0;
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-neutral-800 bg-neutral-950 px-[calc(2.25rem+1px)] pt-4 pb-8 md:pb-4">
      <div className="mx-auto flex max-w-md items-center justify-between gap-2">
        <button
          onClick={onToggleSelectAll}
          className="flex shrink-0 items-center gap-2 text-xs text-neutral-400"
        >
          <Checkbox checked={allSelected} onChange={onToggleSelectAll} />
          {count} selected
        </button>
        <div className="flex gap-1">
          <button
            onClick={onFlag}
            disabled={disabled}
            aria-label={flagLabel}
            title={flagLabel}
            className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900 disabled:opacity-40"
          >
            <Star size={16} />
          </button>
          <button
            onClick={onSuspend}
            disabled={disabled}
            aria-label={suspendLabel}
            title={suspendLabel}
            className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900 disabled:opacity-40"
          >
            <Ban size={16} />
          </button>
          <button
            onClick={onMove}
            disabled={disabled}
            aria-label="Move selected"
            title="Move"
            className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900 disabled:opacity-40"
          >
            <FolderInput size={16} />
          </button>
          <button
            onClick={onDuplicate}
            disabled={disabled}
            aria-label="Duplicate selected"
            title="Duplicate"
            className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900 disabled:opacity-40"
          >
            <Copy size={16} />
          </button>
          <button
            onClick={onDelete}
            disabled={disabled}
            aria-label="Delete selected"
            title="Delete"
            className="flex h-8 w-8 items-center justify-center rounded-md text-red-400 hover:bg-neutral-900 disabled:opacity-40"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
