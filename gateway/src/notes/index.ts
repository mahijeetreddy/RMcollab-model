import { docHub } from "../docs/hub.js";
import { NotesWriter } from "./writer.js";

/** The process-wide writer, editing through the same hub the editors use. */
export const notesWriter = new NotesWriter(docHub);
