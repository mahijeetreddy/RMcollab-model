import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { MediaItemWithJob } from "@rmcollab/shared";
import { NOTES_FIELD } from "@rmcollab/shared/notes";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import { EditorContent, ReactNodeViewRenderer, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { collaboratorColor } from "../../lib/colors";
import { initials } from "../../lib/format";
import type { Realtime } from "../../ws/useRealtime";
import { NotesRoom } from "./context";
import { useCollaborators, useRoomDoc, type DocSession } from "./hooks";
import { docIcons, icons } from "./icons";
import type { CollaboratorUser, SyncStatus } from "./provider";
import { schemaExtensions, UploadSection } from "./schema";
import { SectionView } from "./SectionView";

interface Props {
  realtime: Realtime;
  roomId: string;
  roomName: string;
  sessionCode: string;
  me: { id: string; displayName: string };
  media: MediaItemWithJob[];
  onOpenInFeed: (mediaItemId: string) => void;
  /** The upload form, shown in a panel under the toolbar on demand. */
  uploader: ReactNode;
}

const SAVE_STATE: Record<SyncStatus, string> = {
  connecting: "Syncing…",
  synced: "Saved to the room",
  offline: "Offline · your edits are kept and will sync",
};

// --- toolbar -----------------------------------------------------------------------

interface ToolProps {
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onRun: () => void;
  children: ReactNode;
}

function Tool({ label, shortcut, active, disabled, onRun, children }: ToolProps) {
  return (
    <button
      type="button"
      className="gdoc-tool"
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      title={shortcut ? `${label} (${shortcut})` : label}
      disabled={disabled}
      // Keep the selection: a mousedown on a button would otherwise blur the editor.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRun}
    >
      {children}
    </button>
  );
}

const Divider = () => <span className="gdoc-divider" aria-hidden="true" />;

type BlockStyle = "paragraph" | "h1" | "h2" | "h3";

function Toolbar({ editor, onToggleOutline, outlineOpen }: { editor: Editor; onToggleOutline: () => void; outlineOpen: boolean }) {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      style: (e.isActive("heading", { level: 1 })
        ? "h1"
        : e.isActive("heading", { level: 2 })
          ? "h2"
          : e.isActive("heading", { level: 3 })
            ? "h3"
            : "paragraph") as BlockStyle,
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      highlight: e.isActive("highlight"),
      bullets: e.isActive("bulletList"),
      numbers: e.isActive("orderedList"),
      tasks: e.isActive("taskList"),
      left: e.isActive({ textAlign: "left" }),
      center: e.isActive({ textAlign: "center" }),
      right: e.isActive({ textAlign: "right" }),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const run = (fn: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => () =>
    fn(editor.chain().focus()).run();

  const setStyle = (style: BlockStyle) => {
    const chain = editor.chain().focus();
    if (style === "paragraph") chain.setParagraph().run();
    else chain.setHeading({ level: Number(style.slice(1)) as 1 | 2 | 3 }).run();
  };

  return (
    <div className="gdoc-toolbar" role="toolbar" aria-label="Formatting">
      <Tool label="Show document outline" active={outlineOpen} onRun={onToggleOutline}>
        {icons.outline}
      </Tool>
      <Divider />
      <Tool label="Undo your last change" shortcut={`${mod}+Z`} disabled={!s.canUndo} onRun={run((c) => c.undo())}>
        {icons.undo}
      </Tool>
      <Tool label="Redo" shortcut={`${mod}+Shift+Z`} disabled={!s.canRedo} onRun={run((c) => c.redo())}>
        {icons.redo}
      </Tool>
      <Divider />
      <label className="gdoc-style">
        <span className="visually-hidden">Paragraph style</span>
        <select value={s.style} onChange={(event) => setStyle(event.target.value as BlockStyle)}>
          <option value="paragraph">Normal text</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
        </select>
        <span className="gdoc-style-chevron" aria-hidden="true">
          {icons.chevron}
        </span>
      </label>
      <Divider />
      <Tool label="Bold" shortcut={`${mod}+B`} active={s.bold} onRun={run((c) => c.toggleBold())}>
        {icons.bold}
      </Tool>
      <Tool label="Italic" shortcut={`${mod}+I`} active={s.italic} onRun={run((c) => c.toggleItalic())}>
        {icons.italic}
      </Tool>
      <Tool label="Underline" shortcut={`${mod}+U`} active={s.underline} onRun={run((c) => c.toggleUnderline())}>
        {icons.underline}
      </Tool>
      <Tool label="Strikethrough" shortcut={`${mod}+Shift+S`} active={s.strike} onRun={run((c) => c.toggleStrike())}>
        {icons.strike}
      </Tool>
      <Tool label="Highlight" shortcut={`${mod}+Shift+H`} active={s.highlight} onRun={run((c) => c.toggleHighlight())}>
        {icons.highlight}
      </Tool>
      <Divider />
      <Tool label="Checklist" active={s.tasks} onRun={run((c) => c.toggleTaskList())}>
        {icons.tasks}
      </Tool>
      <Tool label="Bulleted list" active={s.bullets} onRun={run((c) => c.toggleBulletList())}>
        {icons.bullets}
      </Tool>
      <Tool label="Numbered list" active={s.numbers} onRun={run((c) => c.toggleOrderedList())}>
        {icons.numbers}
      </Tool>
      <Divider />
      <Tool label="Align left" active={s.left} onRun={run((c) => c.setTextAlign("left"))}>
        {icons.alignLeft}
      </Tool>
      <Tool label="Align centre" active={s.center} onRun={run((c) => c.setTextAlign("center"))}>
        {icons.alignCenter}
      </Tool>
      <Tool label="Align right" active={s.right} onRun={run((c) => c.setTextAlign("right"))}>
        {icons.alignRight}
      </Tool>
      <Divider />
      <Tool label="Quote" onRun={run((c) => c.toggleBlockquote())}>
        {icons.quote}
      </Tool>
      <Tool label="Code block" onRun={run((c) => c.toggleCodeBlock())}>
        {icons.codeBlock}
      </Tool>
      <Tool label="Clear formatting" onRun={run((c) => c.unsetAllMarks().clearNodes())}>
        {icons.clear}
      </Tool>
    </div>
  );
}

// --- outline -----------------------------------------------------------------------

interface OutlineEntry {
  pos: number;
  depth: number;
  text: string;
  kind: "heading" | "section";
  mediaType?: string;
}

function readOutline(editor: Editor): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  editor.state.doc.descendants((node, pos, parent) => {
    const inSection = parent?.type.name === UploadSection.name;
    if (node.type.name === UploadSection.name) {
      entries.push({ pos, depth: 1, text: String(node.attrs["title"] ?? "Upload"), kind: "section", mediaType: node.attrs["mediaType"] as string });
      return true;
    }
    if (node.type.name === "heading" && node.textContent.trim()) {
      const level = Number(node.attrs["level"] ?? 1);
      entries.push({ pos, depth: Math.min(3, level + (inSection ? 1 : 0)), text: node.textContent.trim(), kind: "heading" });
    }
    return node.type.name === "doc" || node.type.name === UploadSection.name;
  });
  return entries;
}

function Outline({ editor }: { editor: Editor }) {
  const entries = useEditorState({ editor, selector: ({ editor: e }) => readOutline(e) }) ?? [];
  const jump = (pos: number) => {
    editor.chain().focus().setTextSelection(pos + 1).run();
    const dom = editor.view.domAtPos(pos + 1).node;
    const element = dom instanceof Element ? dom : dom.parentElement;
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  return (
    <nav className="gdoc-outline" aria-label="Document outline">
      <p className="gdoc-outline-title">Outline</p>
      {entries.length === 0 ? (
        <p className="gdoc-outline-empty">Headings and uploads you add to the notes appear here.</p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li key={`${entry.pos}-${entry.text}`} className={`depth-${entry.depth} is-${entry.kind}`}>
              <button type="button" onClick={() => jump(entry.pos)} title={entry.text}>
                {entry.kind === "section" && (
                  <span className="gdoc-outline-icon" aria-hidden="true">
                    {docIcons[(entry.mediaType ?? "text") as keyof typeof docIcons] ?? docIcons.text}
                  </span>
                )}
                <span className="gdoc-outline-text">{entry.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

// --- presence and header ---------------------------------------------------------

function Presence({ users, me }: { users: CollaboratorUser[]; me: CollaboratorUser }) {
  const everyone = [me, ...users];
  const shown = everyone.slice(0, 5);
  const extra = everyone.length - shown.length;
  const label = users.length === 0 ? "Only you are here" : `${users.map((u) => u.name).join(", ")} also editing`;
  return (
    <ul className="gdoc-avatars" aria-label={label} title={label}>
      {shown.map((user) => (
        <li key={user.id} className="gdoc-avatar" style={{ ["--who" as string]: user.color }} title={user.id === me.id ? `${user.name} (you)` : user.name}>
          <span aria-hidden="true">{initials(user.name)}</span>
        </li>
      ))}
      {extra > 0 && (
        <li className="gdoc-avatar gdoc-avatar-more">
          <span aria-hidden="true">+{extra}</span>
        </li>
      )}
    </ul>
  );
}

function ShareButton({ sessionCode, roomName }: { sessionCode: string; roomName: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const share = async () => {
    try {
      await navigator.clipboard.writeText(`Join "${roomName}" on RMcollab with session code ${sessionCode}`);
      setCopied(true);
    } catch {
      window.prompt("Copy this session code to invite people:", sessionCode);
    }
  };
  return (
    <button type="button" className="gdoc-share" onClick={share} aria-live="polite">
      {copied ? "Code copied" : "Share"}
    </button>
  );
}

// --- the editor --------------------------------------------------------------------

const Section = UploadSection.extend({
  addNodeView() {
    return ReactNodeViewRenderer(SectionView);
  },
});

function NotesEditor({
  session,
  user,
  roomName,
  outlineOpen,
  onToggleOutline,
  onWords,
}: {
  session: DocSession;
  user: CollaboratorUser;
  roomName: string;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  onWords: (words: number) => void;
}) {
  const editor = useEditor(
    {
      extensions: [
        // The shared schema, with the upload section given its interactive card.
        ...schemaExtensions().map((extension) => (extension.name === UploadSection.name ? Section : extension)),
        Collaboration.configure({ document: session.doc, field: NOTES_FIELD }),
        CollaborationCaret.configure({ provider: session.provider, user }),
        Placeholder.configure({
          placeholder: "Type the room's notes here. Uploads add their summaries as they finish.",
          includeChildren: false,
        }),
        CharacterCount,
      ],
      editorProps: {
        attributes: { class: "notes-prose", "aria-label": `Shared notes for ${roomName}`, spellcheck: "true" },
      },
    },
    [session],
  );

  const words = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? (e.storage.characterCount as { words: () => number }).words() : 0),
  });
  useEffect(() => onWords(words ?? 0), [words, onWords]);

  if (!editor) return null;
  return (
    <>
      <Toolbar editor={editor} outlineOpen={outlineOpen} onToggleOutline={onToggleOutline} />
      <div className={`gdoc-workspace${outlineOpen ? " with-outline" : ""}`}>
        {outlineOpen && <Outline editor={editor} />}
        <div className="gdoc-canvas">
          <div className="gdoc-page">
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>
    </>
  );
}

export default function NotesView({ realtime, roomId, roomName, sessionCode, me, media, onOpenInFeed, uploader }: Props) {
  const user = useMemo<CollaboratorUser>(
    () => ({ id: me.id, name: me.displayName, color: collaboratorColor(me.id) }),
    [me.id, me.displayName],
  );
  const { session, status } = useRoomDoc(realtime, roomId, user);
  const collaborators = useCollaborators(session?.provider ?? null, me.id);
  const [words, setWords] = useState(0);
  const [outlineOpen, setOutlineOpen] = useState(() => window.matchMedia("(min-width: 1100px)").matches);
  const [adding, setAdding] = useState(false);
  const toggleOutline = useCallback(() => setOutlineOpen((open) => !open), []);
  const room = useMemo(() => ({ media, openInFeed: onOpenInFeed }), [media, onOpenInFeed]);

  return (
    <NotesRoom.Provider value={room}>
      <section className="gdoc" aria-labelledby="notes-heading">
        <header className="gdoc-bar">
          <span className="gdoc-logo">{docIcons.doc}</span>
          <div className="gdoc-titles">
            <h3 id="notes-heading">{roomName} notes</h3>
            <p className={`gdoc-save is-${status}`} role="status">
              <span className="gdoc-save-icon" aria-hidden="true">
                {docIcons.cloud}
              </span>
              {SAVE_STATE[status]}
              <span className="gdoc-save-words">
                · {words.toLocaleString()} {words === 1 ? "word" : "words"}
              </span>
            </p>
          </div>
          <div className="gdoc-actions">
            <Presence users={collaborators} me={user} />
            <button
              type="button"
              className="gdoc-add"
              aria-expanded={adding}
              onClick={() => setAdding((open) => !open)}
            >
              Add media
            </button>
            <ShareButton sessionCode={sessionCode} roomName={roomName} />
          </div>
        </header>

        {adding && (
          <div className="gdoc-uploader">
            <p>Uploads get their own section in these notes, filled in as the analysis finishes.</p>
            {uploader}
          </div>
        )}

        {session ? (
          <NotesEditor
            key={roomId}
            session={session}
            user={user}
            roomName={roomName}
            outlineOpen={outlineOpen}
            onToggleOutline={toggleOutline}
            onWords={setWords}
          />
        ) : (
          <div className="gdoc-workspace">
            <div className="gdoc-canvas">
              <div className="gdoc-page gdoc-page-loading" aria-hidden="true">
                <span className="notes-skeleton" />
                <span className="notes-skeleton" />
                <span className="notes-skeleton notes-skeleton-short" />
              </div>
            </div>
          </div>
        )}
      </section>
    </NotesRoom.Provider>
  );
}
