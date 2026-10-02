import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { inviteUrl } from "../../lib/invite";
import { type MediaItemWithJob, type RoomDocument } from "@rmcollab/shared";
import { MAIN_DOC_ID, NOTES_FIELD } from "@rmcollab/shared/notes";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorContent, ReactNodeViewRenderer, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { collaboratorColor } from "../../lib/colors";
import { initials } from "../../lib/format";
import type { Realtime } from "../../ws/useRealtime";
import { parseSourceHref, type SourceTarget } from "../ask/sourceLinks";
import { NotesRoom } from "./context";
import { api } from "../../api/client";
import { ExportMenu } from "./ExportMenu";
import { VersionHistory } from "./VersionHistory";
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
  /** A section to scroll to, from an Ask the room citation. */
  target?: NotesTarget | null;
  /** Content to add at the end, from Ask the room's "Add to notes". */
  insert?: NotesInsert | null;
  /** Follows a citation link in the notes to its source. */
  onOpenSource?: (target: SourceTarget) => void;
  /** Which of the room's documents this is. */
  docId?: string;
  document?: RoomDocument | null;
  /** Back to the room's list of documents. */
  onBack?: () => void;
}

export interface NotesTarget {
  /** A NotesSection key: "u:<mediaItemId>", "h:<n>" or "top". */
  key: string;
  nonce: number;
}

export interface NotesInsert {
  content: JSONContent[];
  nonce: number;
}

/**
 * Where a notes section starts, found by the same rules the gateway uses to cut
 * the notes into sections (notesSections in the shared package): upload
 * sections by their media id, the rest by counting top-level headings.
 */
export function sectionPosition(doc: PMNode, key: string): number | null {
  if (key === "top") return 0;
  let headings = 0;
  let found: number | null = null;
  doc.forEach((node, offset) => {
    if (found !== null) return;
    if (key.startsWith("u:") && node.type.name === UploadSection.name && node.attrs.mediaItemId === key.slice(2)) found = offset;
    if (node.type.name === "heading") {
      if (key === "h:" + headings) found = offset;
      headings += 1;
    }
  });
  return found;
}

/** The source a click on a citation link points at, if it was one. */
function sourceLinkTarget(event: MouseEvent): SourceTarget | null {
  const anchor = event.target instanceof Element ? event.target.closest("a") : null;
  return parseSourceHref(anchor?.getAttribute("href"));
}

/** Scrolls a top-level node into view and marks it for a moment. */
function reveal(editor: Editor, pos: number) {
  const dom = editor.view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  dom.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
  dom.classList.add("is-revealed");
  window.setTimeout(() => dom.classList.remove("is-revealed"), 2200);
}

/** Wide enough for the outline beside a readable page. */
const WIDE_ENOUGH = "(min-width: 1100px)";

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

/**
 * Whether a sticky element is currently stuck, which CSS cannot say. A
 * zero-height marker sits just above it: once the marker scrolls out of its
 * scroll container, the element below it has stuck.
 */
function useStuck<T extends HTMLElement>() {
  const marker = useRef<T | null>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const node = marker.current;
    const root = node?.closest(".panel-body") ?? null;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry!.isIntersecting), {
      root,
      // The scroll area's top padding is where the stuck toolbar sits.
      rootMargin: "-17px 0px 0px 0px",
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { marker, stuck };
}

function Toolbar({ editor, onToggleOutline, outlineOpen }: { editor: Editor; onToggleOutline: () => void; outlineOpen: boolean }) {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  const { marker, stuck } = useStuck<HTMLDivElement>();
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
    <>
    <div ref={marker} className="gdoc-toolbar-marker" aria-hidden="true" />
    <div className={`gdoc-toolbar${stuck ? " is-stuck" : ""}`} role="toolbar" aria-label="Formatting">
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
    </>
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
      await navigator.clipboard.writeText(`Join "${roomName}" on RMcollab: ${inviteUrl(sessionCode)}`);
      setCopied(true);
    } catch {
      window.prompt("Copy this link to invite people:", inviteUrl(sessionCode));
    }
  };
  return (
    <button type="button" className="gdoc-share" onClick={share} aria-live="polite">
      {copied ? "Invite link copied" : "Share"}
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
  onEditor,
  synced,
  target,
  insert,
  onOpenSource,
}: {
  session: DocSession;
  user: CollaboratorUser;
  roomName: string;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  onWords: (words: number) => void;
  onEditor: (editor: Editor | null) => void;
  synced: boolean;
  target: NotesTarget | null;
  insert: NotesInsert | null;
  onOpenSource?: (target: SourceTarget) => void;
}) {
  // Read through a ref: the editor is built once per session, and its click
  // handler must reach the latest callback rather than the first one.
  const openSourceRef = useRef(onOpenSource);
  openSourceRef.current = onOpenSource;
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
        // A citation link opens its source in the app. Any other link keeps
        // the editor's behaviour (a click places the cursor, for editing).
        handleClick: (_view, _pos, event) => {
          const target = sourceLinkTarget(event);
          if (!target) return false;
          event.preventDefault();
          openSourceRef.current?.(target);
          return true;
        },
        // The browser's own link handling (Ctrl-click, middle-click opening a
        // tab) would load the app again at a fragment; a citation is not a page.
        handleDOMEvents: {
          click: (_view, event) => {
            if (sourceLinkTarget(event)) event.preventDefault();
            return false;
          },
          auxclick: (_view, event) => {
            if (sourceLinkTarget(event)) event.preventDefault();
            return false;
          },
        },
      },
    },
    [session],
  );

  const words = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? (e.storage.characterCount as { words: () => number }).words() : 0),
  });
  useEffect(() => onWords(words ?? 0), [words, onWords]);
  useEffect(() => {
    onEditor(editor);
    return () => onEditor(null);
  }, [editor, onEditor]);

  // Both wait for the first sync: before it the page is empty, so a section
  // cannot be found, and content added then could land ahead of the notes that
  // are still arriving.
  const doneTarget = useRef(0);
  useEffect(() => {
    if (!editor || !target || !synced || doneTarget.current === target.nonce) return;
    doneTarget.current = target.nonce;
    const pos = sectionPosition(editor.state.doc, target.key);
    if (pos !== null) window.requestAnimationFrame(() => reveal(editor, pos));
  }, [editor, target, synced]);

  const doneInsert = useRef(0);
  useEffect(() => {
    if (!editor || !insert || !synced || doneInsert.current === insert.nonce) return;
    doneInsert.current = insert.nonce;
    // At the document's end, not the cursor's: the end may be inside an
    // upload's section, and an answer is not part of that upload.
    const at = editor.state.doc.content.size;
    editor.chain().insertContentAt(at, insert.content).run();
    window.requestAnimationFrame(() => reveal(editor, at));
  }, [editor, insert, synced]);

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

export default function NotesView({
  realtime,
  roomId,
  roomName,
  sessionCode,
  me,
  media,
  onOpenInFeed,
  uploader,
  target = null,
  insert = null,
  onOpenSource,
  docId = MAIN_DOC_ID,
  document = null,
  onBack,
}: Props) {
  const isMain = docId === MAIN_DOC_ID;
  const [fetchedTitle, setFetchedTitle] = useState<string | null>(null);
  useEffect(() => {
    if (document || isMain) return;
    let current = true;
    api
      .listDocuments(roomId, me.id)
      .then((docs) => current && setFetchedTitle(docs.find((d) => d.id === docId)?.title ?? null))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [document, isMain, roomId, docId, me.id]);
  const title = document?.title ?? fetchedTitle ?? (isMain ? "Room notes" : "Untitled document");
  const user = useMemo<CollaboratorUser>(
    () => ({ id: me.id, name: me.displayName, color: collaboratorColor(me.id) }),
    [me.id, me.displayName],
  );
  const { session, status } = useRoomDoc(realtime, roomId, docId, user);
  const collaborators = useCollaborators(session?.provider ?? null, me.id);
  const [words, setWords] = useState(0);
  // The outline sits beside the page when there is room for both. It follows the
  // window as it is resized - closing when it gets narrow, reopening when it
  // widens - until the person toggles it themselves, after which it is theirs.
  const [outlineOpen, setOutlineOpen] = useState(() => window.matchMedia(WIDE_ENOUGH).matches);
  const outlineChosen = useRef(false);
  useEffect(() => {
    const query = window.matchMedia(WIDE_ENOUGH);
    const follow = (event: MediaQueryListEvent) => {
      if (!outlineChosen.current) setOutlineOpen(event.matches);
    };
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);
  const [adding, setAdding] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const toggleOutline = useCallback(() => {
    outlineChosen.current = true;
    setOutlineOpen((open) => !open);
  }, []);
  const room = useMemo(() => ({ media, openInFeed: onOpenInFeed }), [media, onOpenInFeed]);

  return (
    <NotesRoom.Provider value={room}>
      <section className="gdoc" aria-labelledby="notes-heading">
        <header className="gdoc-bar">
          {onBack && (
            <button type="button" className="ghost gdoc-back" onClick={onBack} aria-label="All documents">
              <span aria-hidden="true">←</span>
            </button>
          )}
          <span className="gdoc-logo">{docIcons.doc}</span>
          <div className="gdoc-titles">
            <h3 id="notes-heading">{title}</h3>
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
            {/* Uploads write into the room's notes, so that is where adding lives. */}
            {isMain && (
              <button
                type="button"
                className="gdoc-add"
                aria-expanded={adding}
                onClick={() => setAdding((open) => !open)}
              >
                Add media
              </button>
            )}
            <button
              type="button"
              className="gdoc-add gdoc-history"
              onClick={() => setHistoryOpen(true)}
              aria-haspopup="dialog"
              title="Version history"
            >
              History
            </button>
            <ExportMenu editor={editor} roomName={isMain ? roomName : title} media={isMain ? media : []} />
            <ShareButton sessionCode={sessionCode} roomName={roomName} />
          </div>
        </header>

        {adding && isMain && (
          <div className="gdoc-uploader">
            <p>Each upload gets its own section in these notes, filled in as the analysis finishes.</p>
            {uploader}
          </div>
        )}

        {session ? (
          <NotesEditor
            key={`${roomId}:${docId}`}
            session={session}
            user={user}
            roomName={roomName}
            outlineOpen={outlineOpen}
            onToggleOutline={toggleOutline}
            onWords={setWords}
            onEditor={setEditor}
            synced={status === "synced"}
            target={target}
            insert={insert}
            onOpenSource={onOpenSource}
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
        {historyOpen && <VersionHistory roomId={roomId} docId={docId} participantId={me.id} onClose={closeHistory} />}
      </section>
    </NotesRoom.Provider>
  );
}
