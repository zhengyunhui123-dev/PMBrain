import type { SchemaPackManifest, PackPageType, PackLinkType } from './manifest-v1.ts';
export interface BorrowedTypes {
    page_types: PackPageType[];
    link_types: PackLinkType[];
}
export function mergeByKey<T>(layersHighToLow: ReadonlyArray<ReadonlyArray<T>>, keyFn: (item: T) => string): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const layer of layersHighToLow) {
        for (const item of layer) {
            const k = keyFn(item);
            if (seen.has(k))
                continue;
            seen.add(k);
            out.push(item);
        }
    }
    return out;
}
export function mergeUnion<T>(layers: ReadonlyArray<ReadonlyArray<T>>): T[] {
    const seen = new Set<T>();
    const out: T[] = [];
    for (const layer of layers) {
        for (const item of layer) {
            if (seen.has(item))
                continue;
            seen.add(item);
            out.push(item);
        }
    }
    return out;
}
export function mergePageTypes(ancestorsBaseFirst: ReadonlyArray<SchemaPackManifest>, borrowedPageTypes: ReadonlyArray<PackPageType>, child: SchemaPackManifest): PackPageType[] {
    const base = ancestorsBaseFirst[0];
    const middleParentsBaseFirst = ancestorsBaseFirst.slice(1);
    const byName = new Map<string, PackPageType>();
    if (base)
        for (const pt of base.page_types)
            byName.set(pt.name, pt);
    const overrideLayersLowToHigh: ReadonlyArray<ReadonlyArray<PackPageType>> = [
        ...middleParentsBaseFirst.map(p => p.page_types),
        borrowedPageTypes,
        child.page_types,
    ];
    for (const layer of overrideLayersLowToHigh) {
        for (const pt of layer)
            if (byName.has(pt.name))
                byName.set(pt.name, pt);
    }
    const newLayersHighToLow: ReadonlyArray<ReadonlyArray<PackPageType>> = [
        child.page_types,
        borrowedPageTypes,
        ...[...middleParentsBaseFirst].reverse().map(p => p.page_types),
    ];
    const seenNew = new Set<string>();
    const prepended: PackPageType[] = [];
    for (const layer of newLayersHighToLow) {
        for (const pt of layer) {
            if (byName.has(pt.name) || seenNew.has(pt.name))
                continue;
            seenNew.add(pt.name);
            prepended.push(pt);
        }
    }
    return [...prepended, ...byName.values()];
}
export function mergeInheritedManifest(ancestorsBaseFirst: ReadonlyArray<SchemaPackManifest>, child: SchemaPackManifest, borrowed: BorrowedTypes): SchemaPackManifest {
    const ancestorsHighToLow = [...ancestorsBaseFirst].reverse();
    const ancLink = ancestorsHighToLow.map(a => a.link_types);
    const ancFront = ancestorsHighToLow.map(a => a.frontmatter_links);
    const ancEnrich = ancestorsHighToLow.map(a => a.enrichable_types);
    const ancFiling = ancestorsHighToLow.map(a => a.filing_rules);
    const ancTakes = ancestorsHighToLow.map(a => a.takes_kinds);
    return {
        ...child,
        page_types: mergePageTypes(ancestorsBaseFirst, borrowed.page_types, child),
        link_types: mergeByKey([child.link_types, borrowed.link_types, ...ancLink], lt => lt.name),
        frontmatter_links: mergeByKey([child.frontmatter_links, ...ancFront], fl => `${fl.page_type}\x00${fl.link_type}`),
        enrichable_types: mergeByKey([child.enrichable_types, ...ancEnrich], et => et.type),
        filing_rules: mergeByKey([child.filing_rules, ...ancFiling], fr => fr.kind),
        takes_kinds: mergeUnion([child.takes_kinds, ...ancTakes]),
    };
}
