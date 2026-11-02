// The enabled models in the settings, like pi's scoped models: the chat's model menu shows them, and the main agent can
// give them to subagents. A combobox with a search field adds them (the catalog is long), and the list below it shows
// them, each with a remove button. Below: the text generation model, which names chats.

import type { Models } from "@earendil-works/pi-ai/models";
import { CheckmarkIcon, ChevronDownIcon, ChevronUpIcon, CloseIcon, Combobox, IconButton, Select, Text, Tooltip } from "figma-kit";
import { useMemo } from "react";
import { modelGroups } from "./settings";

type Option = { value: string; label: string };

type Props = {
	models: Models;
	/** Provider IDs with a saved credential: their models show. */
	connected: ReadonlySet<string>;
	/** "provider/modelId". Empty: all. */
	value: string[];
	onChange(value: string[]): void;
};

/** The models of the connected providers, by provider, as options. */
function useOptions(models: Models, connected: ReadonlySet<string>) {
	return useMemo(
		() =>
			modelGroups(models, connected).map(({ provider, models: list }) => ({
				label: provider.label,
				items: list.map((model): Option => ({ value: `${provider.id}/${model.id}`, label: model.name })),
			})),
		[models, connected],
	);
}

export function EnabledModels({ models, connected, value, onChange }: Props) {
	const groups = useOptions(models, connected);
	const all = groups.flatMap((group) => group.items);
	const selected = all.filter((option) => value.includes(option.value));
	// The choices for a provider that is not connected stay.
	const hidden = value.filter((ref) => !all.some((option) => option.value === ref));

	return (
		<section className="flex flex-col gap-2">
			<Text weight="strong">Models</Text>
			<Text className="text-secondary">
				The model menu in the chat shows the models that you select, and FigPal can give them to subagents. With no
				selection, it uses all models.
			</Text>
			<Combobox.Root
				items={groups}
				multiple
				value={selected}
				isItemEqualToValue={(item: Option, current: Option) => item.value === current.value}
				onValueChange={(next: Option[]) => onChange([...hidden, ...next.map((option) => option.value)])}
			>
				<Combobox.Trigger aria-label="Models">
					<Combobox.Value>
						{(items: Option[]) => (items.length ? "Add models" : "All models")}
					</Combobox.Value>
					<Combobox.Icon>
						<ChevronDownIcon />
					</Combobox.Icon>
				</Combobox.Trigger>
				<Combobox.Portal>
					<Combobox.Positioner>
						<Combobox.Popup>
							<Combobox.InputGroup>
								<Combobox.SearchInput aria-label="Search models" placeholder="Search models" />
							</Combobox.InputGroup>
							<Combobox.Empty>No models found.</Combobox.Empty>
							<Combobox.List>
								{(group: (typeof groups)[number]) => (
									<Combobox.Group key={group.label} items={group.items}>
										<Combobox.GroupLabel>{group.label}</Combobox.GroupLabel>
										<Combobox.Collection>
											{(option: Option) => (
												<Combobox.Item key={option.value} value={option}>
													<Combobox.ItemIndicator>
														<CheckmarkIcon size="4" />
													</Combobox.ItemIndicator>
													{option.label}
												</Combobox.Item>
											)}
										</Combobox.Collection>
									</Combobox.Group>
								)}
							</Combobox.List>
						</Combobox.Popup>
					</Combobox.Positioner>
				</Combobox.Portal>
			</Combobox.Root>
			{selected.length > 0 && (
				<ul className="flex flex-col">
					{selected.map((option) => (
						<li key={option.value} className="flex items-center gap-2 py-0.5">
							<Text className="min-w-0 flex-1 truncate">{option.label}</Text>
							<Tooltip content="Remove">
								<IconButton
									aria-label={`Remove ${option.label}`}
									onClick={() => onChange(value.filter((ref) => ref !== option.value))}
								>
									<CloseIcon />
								</IconButton>
							</Tooltip>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

// The Select needs a value: "auto" stands for the empty setting.
const AUTOMATIC: Option = { value: "auto", label: "Automatic" };

/** The model that names chats. Empty: Automatic. A chosen model of a provider that is not connected shows as Automatic. */
export function TextModel({ models, connected, value, onChange }: Omit<Props, "value" | "onChange"> & { value: string; onChange(value: string): void }) {
	const groups = useOptions(models, connected);
	const items = [AUTOMATIC, ...groups.flatMap((group) => group.items)];
	const current = items.some((item) => item.value === value) ? value : AUTOMATIC.value;
	return (
		<section className="flex flex-col gap-2">
			<Text weight="strong" id="text-model">
				Text generation model
			</Text>
			<Text className="text-secondary">Names new chats. Automatic uses the cheapest model of the chat's provider.</Text>
			<Select.Root items={items} value={current} onValueChange={(next) => next && onChange(next === AUTOMATIC.value ? "" : next)}>
					<Select.Trigger aria-labelledby="text-model">
						<Select.Value />
						<Select.Icon>
							<ChevronDownIcon />
						</Select.Icon>
					</Select.Trigger>
					<Select.Portal>
						<Select.Positioner>
							<Select.Popup>
								<Select.ScrollUpArrow>
									<ChevronUpIcon />
								</Select.ScrollUpArrow>
								<Select.List>
									<Option option={AUTOMATIC} />
									{groups.map((group) => (
										<Select.Group key={group.label}>
											<Select.GroupLabel>{group.label}</Select.GroupLabel>
											{group.items.map((option) => (
												<Option key={option.value} option={option} />
											))}
										</Select.Group>
									))}
								</Select.List>
								<Select.ScrollDownArrow>
									<ChevronDownIcon />
								</Select.ScrollDownArrow>
							</Select.Popup>
						</Select.Positioner>
					</Select.Portal>
			</Select.Root>
		</section>
	);
}

function Option({ option }: { option: Option }) {
	return (
		<Select.Item value={option.value}>
			<Select.ItemIndicator>
				<CheckmarkIcon size="4" />
			</Select.ItemIndicator>
			<Select.ItemText>{option.label}</Select.ItemText>
		</Select.Item>
	);
}
