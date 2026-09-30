import { mergeAttributes, Node, type Extensions } from "@tiptap/core";
import Highlight from "@tiptap/extension-highlight";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import TextAlign from "@tiptap/extension-text-align";
import StarterKit from "@tiptap/starter-kit";
import { SECTION_NODE } from "@rmcollab/shared/notes";

/**
 * The notes' document schema, without any UI - shared by the editor and by the
 * contract test that loads what the gateway writes (client/test/notesSchema).
 * A node the gateway emits must exist here, with its attributes, or the first
 * browser to load it deletes it.
 */

/** Everything one upload contributed, as a block the room can edit like any other. */
export const UploadSection = Node.create({
  name: SECTION_NODE,
  group: "block",
  // Any block but another section: sections do not nest.
  content: "(paragraph | heading | bulletList | orderedList | taskList | blockquote | codeBlock | horizontalRule)+",
  defining: true,
  isolating: true,
  draggable: true,

  addAttributes() {
    // `attr` is the attribute's name in the document, `html` its data-* name.
    // They differ for camelCase attributes; looking one up by the other once
    // dropped mediaItemId and mediaType from every section's HTML.
    const plain = (attr: string, html: string) => ({
      default: null,
      parseHTML: (el: HTMLElement) => el.getAttribute(`data-${html}`),
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs[attr] === null || attrs[attr] === undefined ? {} : { [`data-${html}`]: String(attrs[attr]) },
    });
    return {
      mediaItemId: plain("mediaItemId", "media-item-id"),
      mediaType: plain("mediaType", "media-type"),
      title: plain("title", "title"),
      author: plain("author", "author"),
      createdAt: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const value = Number(el.getAttribute("data-created-at"));
          return Number.isFinite(value) && value > 0 ? value : null;
        },
        renderHTML: (attrs: Record<string, unknown>) =>
          typeof attrs.createdAt === "number" ? { "data-created-at": String(attrs.createdAt) } : {},
      },
      status: plain("status", "status"),
    };
  },

  parseHTML() {
    return [{ tag: `section[data-type="${SECTION_NODE}"]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["section", mergeAttributes(HTMLAttributes, { "data-type": SECTION_NODE }), 0];
  },
});

/** The schema-defining extensions, in the order the editor uses them. */
export function schemaExtensions(): Extensions {
  return [
    // Collaboration brings its own history, scoped to this user's edits.
    StarterKit.configure({ undoRedo: false, link: { openOnClick: false, autolink: true } }),
    Highlight,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    TaskList,
    TaskItem.configure({ nested: true }),
    UploadSection,
  ];
}
