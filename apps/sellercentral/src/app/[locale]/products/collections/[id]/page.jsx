"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { useRouter, usePathname } from "@/i18n/navigation";
import { Box, Banner, SkeletonBodyText, SkeletonDisplayText, Card, BlockStack, Button } from "@shopify/polaris";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { userError } from "@/lib/api-error-messages";
import DashboardLayout from "@/components/DashboardLayout";
import CollectionEditPage from "@/components/pages/products/CollectionEditPage";

export default function CollectionDetailRoute() {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const id = params?.id;
  const [collection, setCollection] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const client = getMedusaAdminClient();

  const fetchCollection = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      setError(null);
      const data = await client.getCollection(id);
      setCollection(data || null);
      if (!data) setError("Collection not found. It may be managed by a category.");
      else if (data.id != null && String(data.id) !== String(id) && pathname) {
        const newPath = pathname.replace(/[^/]+$/, String(data.id));
        if (newPath !== pathname) router.replace(newPath);
      }
    } catch (err) {
      setError(userError(err, null, "Failed to load collection"));
      setCollection(null);
    } finally {
      setLoading(false);
    }
  }, [id, pathname, router]);

  useEffect(() => {
    fetchCollection();
  }, [fetchCollection]);

  if (loading) {
    return (
      <DashboardLayout>
        <Box padding="400">
          <Card>
            <BlockStack gap="300">
              <SkeletonDisplayText size="small" />
              <SkeletonBodyText lines={5} />
            </BlockStack>
          </Card>
        </Box>
      </DashboardLayout>
    );
  }

  if (error || !collection) {
    return (
      <DashboardLayout>
        <Box padding="400">
          <Banner tone="critical" onDismiss={() => setError(null)}>
            {error || "Collection not found"}
          </Banner>
          <Box paddingBlockStart="400">
            <Button onClick={() => router.push("/products/collections")}>Back to Collections</Button>
          </Box>
        </Box>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <CollectionEditPage collection={collection} isNew={false} onReload={fetchCollection} />
    </DashboardLayout>
  );
}
