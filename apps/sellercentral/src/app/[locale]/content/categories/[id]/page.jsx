"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import { Box, Banner, SkeletonBodyText, SkeletonDisplayText, Card, BlockStack, Button } from "@shopify/polaris";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { userError } from "@/lib/api-error-messages";
import { getCategoryEditCopy } from "@/lib/category-edit-i18n";
import DashboardLayout from "@/components/DashboardLayout";
import CategoryEditPage from "@/components/pages/content/CategoryEditPage";

export default function CategoryDetailRoute() {
  const params = useParams();
  const router = useRouter();
  const locale = useLocale();
  const c = getCategoryEditCopy(locale);
  const id = params?.id;
  const [category, setCategory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const client = getMedusaAdminClient();

  const fetchCategory = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      setError(null);
      const data = await client.getAdminHubCategory(id);
      if (!data) setError(c.notFound);
      else setCategory(data);
    } catch (err) {
      setError(userError(err, locale, c.loadError));
      setCategory(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchCategory(); }, [fetchCategory]);

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

  if (error || !category) {
    return (
      <DashboardLayout>
        <Box padding="400">
          <Banner tone="critical">{error || "Category not found"}</Banner>
          <Box paddingBlockStart="400">
            <Button onClick={() => router.push("/content/categories")}>Back to Categories</Button>
          </Box>
        </Box>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <CategoryEditPage category={category} onReload={fetchCategory} />
    </DashboardLayout>
  );
}
