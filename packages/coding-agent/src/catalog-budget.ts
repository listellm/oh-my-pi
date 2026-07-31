export type BudgetedCatalogEntry<T> = T & { descriptionOmitted?: true };

/**
 * Limits prompt descriptions without changing skill or agent availability.
 *
 * Emptying `description` is the enforcement; `descriptionOmitted` is a
 * rendering hint that lets `system-prompt.md`, `custom-system-prompt.md`, and
 * `task.md` drop the separator rather than emit a dangling one. A budget is
 * spent in array order, so callers decide which entries keep their text.
 *
 * Any negative or non-finite budget means unlimited: a malformed setting must
 * fail open rather than silently blank the whole catalogue.
 */
export function applyCatalogDescriptionBudget<T extends { description: string }>(
	entries: readonly T[],
	budgetChars: number,
): readonly BudgetedCatalogEntry<T>[] {
	if (!Number.isFinite(budgetChars) || budgetChars < 0) return entries;
	if (budgetChars === 0) return entries.map(omitDescription);

	let spent = 0;
	const firstOmitted = entries.findIndex(entry => {
		spent += entry.description.length;
		return spent > budgetChars;
	});
	if (firstOmitted === -1) return entries;

	return entries.map((entry, index) => (index < firstOmitted ? entry : omitDescription(entry)));
}

function omitDescription<T extends { description: string }>(entry: T): BudgetedCatalogEntry<T> {
	return { ...entry, description: "", descriptionOmitted: true };
}
