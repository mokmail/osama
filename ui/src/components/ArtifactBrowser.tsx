/*
 * The artifact browser modal, kept as a thin alias.
 *
 * The sidebar's quick-panel and the full page are now the SAME component, so
 * there is one implementation of "browse what the agent wrote" rather than two
 * that drift. The page adds the folder pane; the modal shows the same list.
 */
export { ArtifactsView as ArtifactsModal } from "../views/Artifacts";
