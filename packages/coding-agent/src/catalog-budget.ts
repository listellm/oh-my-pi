type BudgetedCatalogEntry<T> = T & { descriptionOmitted?: true };

/** Limits prompt descriptions without changing skill or agent availability. */
export function applyCatalogDescriptionBudget<T extends { description: string }>(
	entries: readonly T[],
	budgetChars: number,
): readonly BudgetedCatalogEntry<T>[] {
	if (budgetChars < 0) return entries;
	if (budgetChars === 0) {
		return entries.map(entry => ({ ...entry, description: "", descriptionOmitted: true }));
	}

	let spent = 0;
	const firstOmitted = entries.findIndex(entry => {
		spent += entry.description.length;
		return spent > budgetChars;
	});
	if (firstOmitted === -1) return entries;

	return entries.map((entry, index) =>
		index < firstOmitted ? entry : { ...entry, description: "", descriptionOmitted: true },
	);
}
