import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./icons";

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = "regular"
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  size?: "regular" | "wide";
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = `dialog-title-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const descriptionId = `${titleId}-description`;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className={`modal ${size === "wide" ? "modal--wide" : ""}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="modal__inner">
        <div className="modal__heading">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId} className="modal__description">{description}</p>}
          </div>
          <button className="icon-button modal__close" type="button" aria-label="Close dialog" onClick={onClose}>
            <Icon name="x" size={17} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
