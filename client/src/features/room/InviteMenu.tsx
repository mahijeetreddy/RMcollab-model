import { useEffect, useRef, useState } from "react";
import { formatSessionCode } from "@rmcollab/shared";
import { deviceUrl, inviteUrl } from "../../lib/invite";

/**
 * The session code in the header, and what to do with it: copy an invite link
 * for others, or a private link that continues as you on another device.
 */
export function InviteMenu({ code, participantId }: { code: string; participantId: string | null }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"invite" | "device" | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // Into the menu when it opens, so the keyboard is where the eyes are.
    firstRef.current?.focus();
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const copy = async (which: "invite" | "device", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      window.prompt("Copy this link:", text);
    }
  };

  return (
    <div className="invite" ref={wrapRef}>
      <button
        ref={toggleRef}
        type="button"
        className="code-chip invite-toggle"
        aria-expanded={open}
        aria-controls="invite-menu"
        aria-label={`Session code ${formatSessionCode(code)}. Invite people`}
        onClick={() => setOpen((v) => !v)}
      >
        {formatSessionCode(code)}
      </button>
      {open && (
        <div className="invite-menu" id="invite-menu" role="dialog" aria-label="Invite people">
          <div className="invite-block">
            <p className="invite-title">Invite people</p>
            <p className="invite-detail">Anyone with this link can join. Or give them the code, {formatSessionCode(code)}.</p>
            <button ref={firstRef} type="button" className="primary" onClick={() => void copy("invite", inviteUrl(code))}>
              {copied === "invite" ? "Invite link copied" : "Copy invite link"}
            </button>
          </div>
          {participantId && (
            <div className="invite-block">
              <p className="invite-title">Use on another device</p>
              <p className="invite-detail">
                Opens this session as you, with your uploads and the owner's controls if you started it. Keep it
                private: whoever has this link <em>is</em> you here. Save it somewhere safe to get back in if this
                browser's data is cleared.
              </p>
              <button type="button" className="ghost" onClick={() => void copy("device", deviceUrl(code, participantId))}>
                {copied === "device" ? "Private link copied" : "Copy my private link"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
