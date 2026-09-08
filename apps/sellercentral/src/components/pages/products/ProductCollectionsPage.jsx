"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import { Link } from "@/i18n/navigation";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  Box,
  Banner,
  Button,
  InlineStack,
  IndexTable,
  EmptyState,
  Modal,
} from "@shopify/polaris";
import { EditIcon, DeleteIcon } from "@shopify/polaris-icons";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { getProductCollectionsCopy } from "@/lib/products-pages-i18n";
import { userError } from "@/lib/api-error-messages";

export default function ProductCollectionsPage() {
  const router = useRouter();
  const locale = useLocale();
  const copy = getProductCollectionsCopy(locale);
  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deleteId, setDeleteId] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const client = getMedusaAdminClient();

  const fetchCollections = async () => {
    try {
      setLoading(true);
      setError(null);
      const ids = new Set();
      const list = [];

      try {
        const data = await client.getMedusaCollections({ adminHub: true });
        const allList = data?.collections || [];
        for (const c of allList) {
          if (c?.id && !ids.has(c.id)) {
            ids.add(c.id);
            list.push({
              id: c.id,
              title: c.title ?? c.name,
              handle: c.handle ?? c.slug,
              _standalone: !!c._standalone,
              _fromCategory: !!c._fromCategory,
            });
          }
        }
      } catch (_) {}

      setCollections(list);
    } catch (err) {
      setError(userError(err, locale, copy.loadError));
      setCollections([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCollections();
  }, []);

  const openAdd = () => router.push("/products/collections/new");
  const openEdit = (col) => router.push(`/products/collections/${col.id}`);

  const handleDeleteCollection = async () => {
    if (!deleteId) return;
    try {
      setDeleting(true);
      setError(null);
      await client.deleteCollection(deleteId);
      setDeleteId(null);
      await fetchCollections();
    } catch (err) {
      setError(userError(err, locale, copy.deleteError));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Page
      title={copy.pageTitle}
      subtitle={copy.pageSubtitle}
      primaryAction={{ content: copy.addCollection, onAction: openAdd }}
    >
      <Layout>
        {error && (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          </Layout.Section>
        )}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingSm">
                {copy.pageTitle}
              </Text>
              {loading ? (
                <Box paddingBlock="400">
                  <Text as="p" tone="subdued">
                    {copy.loading}
                  </Text>
                </Box>
              ) : collections.length === 0 ? (
                <EmptyState
                  heading={copy.emptyTitle}
                  action={{ content: copy.addCollection, onAction: openAdd }}
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>{copy.emptyBody}</p>
                </EmptyState>
              ) : (
                <IndexTable
                  resourceName={{ singular: copy.singular, plural: copy.plural }}
                  itemCount={collections.length}
                  selectable={false}
                  headings={[{ title: copy.titleCol }, { title: copy.handleCol }, { title: "ID" }, { title: "" }]}
                >
                  {collections.map((col, index) => (
                    <IndexTable.Row id={col.id} key={col.id} position={index}>
                      <IndexTable.Cell>
                        <Link href={`/products/collections/${col.id}`} style={{ fontWeight: 600, color: "inherit", textDecoration: "none" }}>
                          {col.title ?? col.name ?? "—"}
                        </Link>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" tone="subdued">
                          {col.handle ?? "—"}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {col.id}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="200">
                          <Button size="slim" variant="plain" tone="subdued" accessibilityLabel={copy.edit} icon={EditIcon} onClick={() => openEdit(col)} />
                          <Button size="slim" variant="plain" tone="critical" accessibilityLabel={copy.del} icon={DeleteIcon} onClick={() => setDeleteId(col.id)} />
                        </InlineStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={!!deleteId}
        onClose={() => !deleting && setDeleteId(null)}
        title={copy.deleteTitle}
        primaryAction={{
          content: deleting ? copy.deleting : copy.del,
          destructive: true,
          onAction: handleDeleteCollection,
          loading: deleting,
        }}
        secondaryActions={[{ content: copy.cancel, onAction: () => setDeleteId(null) }]}
      >
        <Modal.Section>
          <Text as="p">
            {copy.deleteConfirmPrefix} &quot;{collections.find((c) => c.id === deleteId)?.title || copy.thisCollection}&quot;?
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
