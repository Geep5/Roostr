/**
 * Active channel selection — module-level reactive state shared by the
 * sidebar, home page, and creation flows. Persisted to localStorage by
 * the layout.
 */
export const activeChannel = $state({ id: "" });
