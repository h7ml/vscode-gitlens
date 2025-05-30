import type { Disposable, QuickInputButton, QuickPickItem } from 'vscode';
import { env, ThemeIcon, Uri, window } from 'vscode';
import type { OpenOnRemoteCommandArgs } from '../commands/openOnRemote';
import { SetRemoteAsDefaultQuickInputButton } from '../commands/quickCommand.buttons';
import type { Keys } from '../constants';
import { GlyphChars } from '../constants';
import type { IntegrationIds } from '../constants.integrations';
import type { Sources } from '../constants.telemetry';
import { Container } from '../container';
import { RequiresIntegrationError } from '../errors';
import type { GitRemote } from '../git/models/remote';
import type { RemoteResource } from '../git/models/remoteResource';
import { RemoteResourceType } from '../git/models/remoteResource';
import type { RemoteProvider } from '../git/remotes/remoteProvider';
import { getDefaultBranchName } from '../git/utils/-webview/branch.utils';
import { getBranchNameWithoutRemote, getRemoteNameFromBranchName } from '../git/utils/branch.utils';
import { getHighlanderProviders } from '../git/utils/remote.utils';
import { getNameFromRemoteResource } from '../git/utils/remoteResource.utils';
import { providersMetadata } from '../plus/integrations/providers/models';
import { convertRemoteProviderIdToIntegrationId } from '../plus/integrations/utils/-webview/integration.utils';
import { getQuickPickIgnoreFocusOut } from '../system/-webview/vscode';
import { getSettledValue } from '../system/promise';
import { CommandQuickPickItem, createQuickPickItemOfT } from './items/common';
import { createDirectiveQuickPickItem, Directive } from './items/directive';

export class ConfigureCustomRemoteProviderCommandQuickPickItem extends CommandQuickPickItem {
	constructor() {
		super({ label: 'See how to configure a custom remote provider...' });
	}

	override async execute(): Promise<void> {
		await env.openExternal(
			Uri.parse('https://help.gitkraken.com/gitlens/gitlens-settings/#remote-provider-integration-settings'),
		);
	}
}

export class CopyOrOpenRemoteCommandQuickPickItem extends CommandQuickPickItem {
	constructor(
		private readonly remote: GitRemote<RemoteProvider>,
		private readonly resources: RemoteResource[],
		private readonly clipboard?: boolean,
		buttons?: QuickInputButton[],
	) {
		super({
			label: `$(repo) ${remote.provider.path}`,
			description: remote.name,
			buttons: buttons,
		});
	}

	override async execute(): Promise<void> {
		const resourcesResults = await Promise.allSettled(
			this.resources.map(async resource => {
				if (resource.type === RemoteResourceType.Comparison) {
					if (getRemoteNameFromBranchName(resource.base) === this.remote.name) {
						resource = { ...resource, base: getBranchNameWithoutRemote(resource.base) };
					}

					if (getRemoteNameFromBranchName(resource.head) === this.remote.name) {
						resource = { ...resource, head: getBranchNameWithoutRemote(resource.head) };
					}
				} else if (resource.type === RemoteResourceType.CreatePullRequest) {
					let branch = resource.base.branch;
					if (branch == null) {
						branch = await getDefaultBranchName(Container.instance, this.remote.repoPath, this.remote.name);
						if (branch) {
							branch = getBranchNameWithoutRemote(branch);
						}
					}

					resource = {
						...resource,
						base: {
							branch: branch,
							remote: { path: this.remote.path, url: this.remote.url, name: this.remote.name },
						},
					};

					if (
						resource.base.remote.url !== resource.head.remote.url &&
						!(await this.remote.provider.isReadyForForCrossForkPullRequestUrls())
					) {
						const integrationId = convertRemoteProviderIdToIntegrationId(this.remote.provider.id);
						const connected =
							integrationId && (await this.showIntegrationConnectionPicker(integrationId, 'view'));
						if (!connected) {
							return undefined;
						}
					}
				} else if (
					resource.type === RemoteResourceType.File &&
					resource.branchOrTag != null &&
					(this.remote.provider.id === 'bitbucket' || this.remote.provider.id === 'bitbucket-server')
				) {
					// HACK ALERT
					// Since Bitbucket can't support branch names in the url (other than with the default branch),
					// turn this into a `Revision` request
					const { branchOrTag } = resource;
					const svc = Container.instance.git.getRepositoryService(this.remote.repoPath);
					const [branches, tags] = await Promise.allSettled([
						svc.branches.getBranches({
							filter: b => b.name === branchOrTag || b.getNameWithoutRemote() === branchOrTag,
						}),
						svc.tags.getTags({ filter: t => t.name === branchOrTag }),
					]);

					const sha = getSettledValue(branches)?.values[0]?.sha ?? getSettledValue(tags)?.values[0]?.sha;
					if (sha) {
						resource = { ...resource, type: RemoteResourceType.Revision, sha: sha };
					}
				}

				return resource;
			}),
		);

		const resources = resourcesResults
			.map(r => {
				if (r.status === 'fulfilled') {
					return r.value;
				}
				if (r.reason instanceof RequiresIntegrationError) {
					throw r.reason;
				}
				return undefined;
			})
			.filter((r): r is RemoteResource => r !== undefined);

		void (await (this.clipboard ? this.remote.provider.copy(resources) : this.remote.provider.open(resources)));
	}

	async showIntegrationConnectionPicker(integrationId: IntegrationIds, source: Sources): Promise<boolean> {
		const disposables: Disposable[] = [];
		const quickpick = window.createQuickPick<QuickPickItem>();
		try {
			const integrationName = providersMetadata[integrationId].name;
			const connectItem = createQuickPickItemOfT(
				{
					label: `Connect to ${integrationName}...`,
					detail: `Connect an integration with ${integrationName} to create cross-repository pull requests`,
					picked: true,
				},
				true,
			);
			const cancelItem = createDirectiveQuickPickItem(Directive.Cancel, false, { label: 'Cancel' });
			const quickpickPromise = new Promise<undefined | QuickPickItem>(resolve => {
				disposables.push(
					quickpick.onDidHide(() => resolve(undefined)),
					quickpick.onDidAccept(() => {
						if (quickpick.activeItems.length !== 0) {
							resolve(quickpick.activeItems[0]);
						}
					}),
				);
			});
			quickpick.ignoreFocusOut = getQuickPickIgnoreFocusOut();
			quickpick.title = `Connect ${integrationName} Integration`;
			quickpick.placeholder = `Requires an integration with ${integrationName} to create cross-repository pull requests`;
			quickpick.matchOnDetail = true;
			quickpick.items = [connectItem, cancelItem];
			quickpick.show();
			const pick = await quickpickPromise;
			if (pick === connectItem) {
				const connected = await Container.instance.integrations.connectCloudIntegrations(
					{ integrationIds: [integrationId] },
					{
						source: source,
					},
				);
				return connected;
			}
		} finally {
			quickpick.dispose();
			disposables.forEach(d => void d.dispose());
		}
		return false;
	}

	setAsDefault(): Promise<void> {
		return this.remote.setAsDefault(true);
	}
}

export class CopyRemoteResourceCommandQuickPickItem extends CommandQuickPickItem {
	constructor(remotes: GitRemote<RemoteProvider>[], resource: RemoteResource) {
		const providers = getHighlanderProviders(remotes);
		const commandArgs: OpenOnRemoteCommandArgs = {
			resource: resource,
			remotes: remotes,
			clipboard: true,
		};
		const label = `Copy Link to ${getNameFromRemoteResource(resource)} for ${
			providers?.length ? providers[0].name : 'Remote'
		}${providers?.length === 1 ? '' : GlyphChars.Ellipsis}`;
		super(label, new ThemeIcon('copy'), 'gitlens.openOnRemote', [commandArgs]);
	}

	override async onDidPressKey(key: Keys): Promise<void> {
		await super.onDidPressKey(key);
		void window.showInformationMessage('URL copied to the clipboard');
	}
}

export class OpenRemoteResourceCommandQuickPickItem extends CommandQuickPickItem {
	constructor(remotes: GitRemote<RemoteProvider>[], resource: RemoteResource) {
		const providers = getHighlanderProviders(remotes);
		const commandArgs: OpenOnRemoteCommandArgs = {
			resource: resource,
			remotes: remotes,
			clipboard: false,
		};
		super(
			`Open ${getNameFromRemoteResource(resource)} on ${
				providers?.length === 1
					? providers[0].name
					: `${providers?.length ? providers[0].name : 'Remote'}${GlyphChars.Ellipsis}`
			}`,
			new ThemeIcon('link-external'),
			'gitlens.openOnRemote',
			[commandArgs],
		);
	}
}

export async function showRemoteProviderPicker(
	title: string,
	placeholder: string,
	resources: RemoteResource[],
	remotes: GitRemote<RemoteProvider>[],
	options?: {
		autoPick?: 'default' | boolean;
		clipboard?: boolean;
		setDefault?: boolean;
	},
): Promise<ConfigureCustomRemoteProviderCommandQuickPickItem | CopyOrOpenRemoteCommandQuickPickItem | undefined> {
	const { autoPick, clipboard, setDefault } = {
		autoPick: false,
		clipboard: false,
		setDefault: true,
		...options,
	};

	let items: (ConfigureCustomRemoteProviderCommandQuickPickItem | CopyOrOpenRemoteCommandQuickPickItem)[];
	if (remotes.length === 0) {
		items = [new ConfigureCustomRemoteProviderCommandQuickPickItem()];
		placeholder = 'No auto-detected or configured remote providers found';
	} else {
		if (autoPick === 'default' && remotes.length > 1) {
			// If there is a default just execute it directly
			const remote = remotes.find(r => r.default);
			if (remote != null) {
				remotes = [remote];
			}
		}

		items = remotes.map(
			r =>
				new CopyOrOpenRemoteCommandQuickPickItem(
					r,
					resources,
					clipboard,
					setDefault ? [SetRemoteAsDefaultQuickInputButton] : undefined,
				),
		);
	}

	if (autoPick && remotes.length === 1) return items[0];

	const quickpick = window.createQuickPick<
		ConfigureCustomRemoteProviderCommandQuickPickItem | CopyOrOpenRemoteCommandQuickPickItem
	>();
	quickpick.ignoreFocusOut = getQuickPickIgnoreFocusOut();

	const disposables: Disposable[] = [];

	try {
		const pick = await new Promise<
			ConfigureCustomRemoteProviderCommandQuickPickItem | CopyOrOpenRemoteCommandQuickPickItem | undefined
		>(resolve => {
			disposables.push(
				quickpick.onDidHide(() => resolve(undefined)),
				quickpick.onDidAccept(() => {
					if (quickpick.activeItems.length !== 0) {
						resolve(quickpick.activeItems[0]);
					}
				}),
				quickpick.onDidTriggerItemButton(async e => {
					if (
						e.button === SetRemoteAsDefaultQuickInputButton &&
						e.item instanceof CopyOrOpenRemoteCommandQuickPickItem
					) {
						await e.item.setAsDefault();
						resolve(e.item);
					}
				}),
			);

			quickpick.title = title;
			quickpick.placeholder = placeholder;
			quickpick.matchOnDetail = true;
			quickpick.items = items;

			quickpick.show();
		});
		if (pick == null) return undefined;

		return pick;
	} finally {
		quickpick.dispose();
		disposables.forEach(d => void d.dispose());
	}
}
