'use client';

import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  // Rendered before the title (e.g. a back-arrow button).
  leading?: React.ReactNode;
  // Rendered after the title, before the close button (e.g. an Edit button).
  trailing?: React.ReactNode;
  showCloseButton?: boolean;
  closeOnBackdropClick?: boolean;
  // 'scroll' (default): grows up to maxHeightClassName, then scrolls.
  // 'fit': no max-height/overflow — just grows to its (short, fixed) content.
  // 'bounded': a fixed-height flex column — for content that manages its own
  // internal scroll regions (e.g. CardFaces/ScrollFade), which needs a
  // bounded flex parent to compute against rather than a natural height.
  size?: 'scroll' | 'fit' | 'bounded';
  maxHeightClassName?: string;
  heightClassName?: string;
  children: React.ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  leading,
  trailing,
  showCloseButton = true,
  closeOnBackdropClick = false,
  size = 'scroll',
  maxHeightClassName = 'max-h-[85vh]',
  heightClassName = 'h-[70vh]',
  children,
}: ModalProps) {
  if (!open) return null;

  const boxSizeClassName =
    size === 'bounded'
      ? `flex ${heightClassName} flex-col`
      : size === 'fit'
        ? ''
        : `${maxHeightClassName} overflow-y-auto overflow-x-hidden`;

  return (
    <div
      className="fixed inset-0 z-50 flex cursor-default items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        // Always swallow the click here, even when backdrop-click-to-close
        // is off — this backdrop isn't portaled to document.body, it's
        // rendered inline wherever the Modal is used (e.g. inside CardRow's
        // own row), so without this a click that lands on the dimmed
        // backdrop (visually "outside" the modal) would otherwise bubble
        // straight through to whatever's underneath in the DOM tree, like
        // the row's own onClick — which is exactly what was popping the
        // Card preview modal open behind the Duplicate/Move modal.
        e.stopPropagation();
        if (!closeOnBackdropClick) return;
        onClose();
      }}
    >
      <div
        className={`w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-950 p-4 ${boxSizeClassName}`}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || leading || trailing || showCloseButton) && (
          <div className={`mb-3 flex items-center justify-between ${size === 'bounded' ? 'shrink-0' : ''}`}>
            <div className="flex items-center gap-2">
              {leading}
              {title && <p className="text-sm font-medium">{title}</p>}
            </div>
            <div className="flex items-center gap-3">
              {trailing}
              {showCloseButton && (
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="text-neutral-400 hover:text-neutral-200"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
