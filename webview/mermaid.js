// Mermaid for the Markdown view. It is a bundle of its own (dist/mermaid/, split into chunks) that
// media/markdown.js imports only when a document has a diagram; Mermaid in turn loads the code of a
// diagram type when the first diagram of that type is drawn.
import mermaid from 'mermaid';

let applied = '';

/**
 * Draws one diagram and resolves with its SVG; a syntax error rejects with Mermaid's message.
 * @param {string} id Id of the `<svg>`, unique on the page: the picture's own styles are scoped by it.
 * @param {string} source
 * @param {object} look The part of Mermaid's configuration that follows the VS Code theme.
 * @param {HTMLElement} stage Hidden element in which the picture is laid out and measured.
 */
export async function draw(id, source, look, stage) {
  const key = JSON.stringify(look);
  if (key !== applied) {
    mermaid.initialize({
      ...look,
      startOnLoad: false,
      // Labels are sanitized and click handlers are off. A diagram can't change this from its own directives.
      securityLevel: 'strict',
      // Otherwise a syntax error leaves Mermaid's own error picture in the stage.
      suppressErrorRendering: true,
      logLevel: 'fatal',
    });
    applied = key;
  }
  const { svg } = await mermaid.render(id, source, stage);
  return svg;
}
