import type { HydrateCodeInput, HydratePayload } from '../contracts.ts';

type BrowserPage = any;

export async function runHydrateStateInBrowser(
  page: BrowserPage,
  input: HydrateCodeInput,
): Promise<HydratePayload> {
  const { target, workspaceUrl } = input;
  const sleep = (ms: number) => page.waitForTimeout(ms);
  const isHomeTitle = (title: string): boolean =>
    /(?:^|!\s*)Home - /i.test(title);

  const scrollAllToTop = async (): Promise<void> => {
    await page
      .evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('*')).filter(
          (node) =>
            node instanceof HTMLElement &&
            node.scrollHeight > node.clientHeight + 20,
        ) as HTMLElement[];

        for (const node of nodes) {
          node.scrollTop = 0;
        }

        const rootScroller =
          document.scrollingElement ?? document.documentElement;
        rootScroller.scrollTop = 0;
      })
      .catch(() => null);
  };

  const clickFirstVisible = async (names: RegExp[]): Promise<boolean> => {
    for (const name of names) {
      const locators = [
        page.getByRole('button', { name }).first(),
        page.getByRole('link', { name }).first(),
        page.getByRole('tab', { name }).first(),
        page.getByText(name).first(),
      ];

      for (const locator of locators) {
        const visible = await locator.isVisible().catch(() => false);
        if (!visible) {
          continue;
        }

        await locator.click().catch(() => null);
        await sleep(1500);
        return true;
      }
    }

    return false;
  };

  const clickChannelDirectoriesEntry = async (): Promise<boolean> => {
    const locators = [
      page.getByRole('treeitem', { name: /^Directories$/i }).first(),
      page.getByRole('button', { name: /^Directories$/i }).first(),
      page.getByRole('tab', { name: /^Directories$/i }).first(),
      page.getByText(/^Directories$/i).first(),
    ];

    for (const locator of locators) {
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await locator.click().catch(() => null);
      await sleep(1200);
      return true;
    }

    return false;
  };

  const clickHomeBreadcrumb = async (): Promise<boolean> => {
    const locators = [
      page
        .getByRole('toolbar', { name: 'Breadcrumbs' })
        .getByRole('button', { name: /^Home$/i })
        .first(),
      page
        .getByRole('toolbar', { name: 'Breadcrumbs' })
        .getByRole('button', { name: /Home/i })
        .first(),
      page
        .getByRole('toolbar', { name: 'Breadcrumbs' })
        .getByRole('link', { name: /Home/i })
        .first(),
    ];

    for (const locator of locators) {
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await locator.click().catch(() => null);
      await sleep(2000);
      if (isHomeTitle(await page.title())) {
        return true;
      }
    }

    return false;
  };

  const clickChannelsTabInDirectories = async (): Promise<boolean> => {
    return await page
      .evaluate(() => {
        const homeGroup = document.querySelector(
          '[role="group"][aria-label="Home"]',
        );
        if (!(homeGroup instanceof HTMLElement)) {
          return false;
        }

        const directoriesEntry = Array.from(
          homeGroup.querySelectorAll(
            '[role=treeitem],[role=button],[role=tab],button,a',
          ),
        ).find((element) => {
          const label = [
            element.getAttribute('aria-label') || '',
            element.textContent || '',
          ]
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

          return /^directories$/i.test(label) || /\bdirectories\b/i.test(label);
        });

        const directoriesContainer =
          directoriesEntry instanceof HTMLElement
            ? directoriesEntry.parentElement
            : null;
        const searchRoot = directoriesContainer ?? homeGroup;

        const candidates = Array.from(
          searchRoot.querySelectorAll('[role=tab],[role=button],button,a'),
        );

        const target = candidates.find((element) => {
          const label = [
            element.getAttribute('aria-label') || '',
            element.textContent || '',
          ]
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

          return /^channels$/i.test(label);
        });

        if (!(target instanceof HTMLElement)) {
          return false;
        }

        target.click();
        return true;
      })
      .catch(() => false);
  };

  const buildCandidateUrls = (): string[] => {
    const originMatch = workspaceUrl.match(/^(https?:\/\/[^/]+)/);
    const teamId = workspaceUrl.match(/\/client\/([^/]+)/)?.[1];
    if (!originMatch || !teamId) {
      return [];
    }
    const origin = originMatch[1];

    const candidates =
      target === 'channels'
        ? []
        : [
            `/client/${teamId}/browse-people`,
            `/client/${teamId}/team`,
            `/client/${teamId}/people-and-user-groups`,
          ];

    return candidates.map((pathname) => `${origin}${pathname}`);
  };

  const isExpectedTargetView = async (): Promise<boolean> => {
    return await page
      .evaluate((currentTarget: 'channels' | 'users') => {
        const pageText = (document.body?.innerText || '')
          .replace(/\s+/g, ' ')
          .trim();

        if (currentTarget === 'channels') {
          return (
            /browse channels|channel browser|all channels|directories|channels and direct messages/i.test(
              document.title,
            ) ||
            /browse channels|channel browser|all channels|directories|channels and direct messages/i.test(
              pageText,
            )
          );
        }

        return (
          /people|directory|members/i.test(document.title) ||
          /people|directory|members/i.test(pageText)
        );
      }, target)
      .catch(() => false);
  };

  const openTargetView = async (): Promise<boolean> => {
    if (target === 'channels') {
      await page
        .goto(workspaceUrl, { waitUntil: 'domcontentloaded' })
        .catch(() => null);
      await sleep(2000);
      const clickedHome = await clickHomeBreadcrumb();
      await sleep(2000);
      if (!clickedHome || !isHomeTitle(await page.title())) {
        return false;
      }
      await scrollAllToTop();
      await sleep(800);

      const clickedDirectories =
        (await clickChannelDirectoriesEntry()) ||
        (await clickFirstVisible([/^Directories$/i, /^Directory$/i]));
      if (clickedDirectories) {
        await sleep(1000);
        await clickChannelsTabInDirectories();
        await sleep(1000);
      }

      return isHomeTitle(await page.title()) && (await isExpectedTargetView());
    }

    const directCandidates = buildCandidateUrls();
    for (const candidate of directCandidates) {
      await page
        .goto(candidate, { waitUntil: 'domcontentloaded' })
        .catch(() => null);
      await sleep(1500);
      if (page.url() === candidate && (await isExpectedTargetView())) {
        return true;
      }
    }

    const labels = [/People/i, /Directory/i, /Members/i];
    const clicked = await clickFirstVisible(labels);
    if (!clicked) {
      return false;
    }
    return await isExpectedTargetView();
  };

  const runScrollPasses = async (maxPasses: number): Promise<number> => {
    let completed = 0;
    for (let attempt = 0; attempt < maxPasses; attempt += 1) {
      const changed = await page
        .evaluate((currentTarget: 'channels' | 'users') => {
          const pageText = (document.body?.innerText || '')
            .replace(/\s+/g, ' ')
            .trim();

          if (
            currentTarget === 'channels' &&
            !/browse channels|channel browser|all channels|directories|channels and direct messages/i.test(
              `${document.title} ${pageText}`,
            )
          ) {
            return false;
          }

          if (
            currentTarget === 'users' &&
            !/people|directory|members/i.test(`${document.title} ${pageText}`)
          ) {
            return false;
          }

          const elements = Array.from(document.querySelectorAll('*')).filter(
            (node) =>
              node instanceof HTMLElement &&
              node.clientHeight > 200 &&
              node.scrollHeight > node.clientHeight + 100,
          ) as HTMLElement[];

          const preferredElements = elements.filter((element) => {
            const label = [
              element.getAttribute('aria-label') || '',
              element.textContent || '',
            ]
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();

            return currentTarget === 'channels'
              ? /channel|channels|directories|direct messages/i.test(label)
              : /people|member|members|directory/i.test(label);
          });

          const ordered = (
            preferredElements.length > 0 ? preferredElements : elements
          ).sort((left, right) => right.scrollHeight - left.scrollHeight);
          let moved = false;

          for (const element of ordered.slice(0, 4)) {
            const nextTop = Math.min(
              element.scrollTop + element.clientHeight * 0.9,
              element.scrollHeight,
            );
            if (nextTop > element.scrollTop + 4) {
              element.scrollTop = nextTop;
              moved = true;
            }
          }

          const scroller =
            document.scrollingElement ?? document.documentElement;
          const pageNextTop = Math.min(
            scroller.scrollTop + window.innerHeight * 0.9,
            scroller.scrollHeight,
          );
          if (pageNextTop > scroller.scrollTop + 4) {
            scroller.scrollTop = pageNextTop;
            moved = true;
          }

          return moved;
        }, target)
        .catch(() => false);

      if (!changed) {
        break;
      }

      completed += 1;
      await sleep(400);
    }

    return completed;
  };

  await page.goto(workspaceUrl, { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  const openedView = await openTargetView();
  await sleep(1500);
  const scrollPasses = await runScrollPasses(openedView ? 24 : 8);

  await page.goto(workspaceUrl, { waitUntil: 'domcontentloaded' });
  await sleep(1000);

  return {
    mode: 'hydrate' as const,
    finalUrl: page.url(),
    openedView,
    pageTitle: await page.title(),
    scrollPasses,
    target,
  };
}
