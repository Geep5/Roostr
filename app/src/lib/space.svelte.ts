/**
 * Active space selection — module-level reactive state shared by the
 * sidebar, home page, and creation flows. Persisted to localStorage by
 * the layout.
 */
export const activeSpace = $state({ id: "" });
