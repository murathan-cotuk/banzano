"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import {
  Page,
  Layout,
  Card,
  Button,
  Text,
  TextField,
  Select,
  BlockStack,
  InlineStack,
  Box,
  Banner,
  FormLayout,
  Divider,
} from "@shopify/polaris";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import ProductDescriptionEditor from "@/components/inputs/ProductDescriptionEditor";
import CategoryDrilldownSelect from "@/components/inputs/CategoryDrilldownSelect";
import { getSingleUploadCopy } from "@/lib/products-pages-i18n";
import { userError } from "@/lib/api-error-messages";

const VARIANT_TYPES = [
  { name: "Color", commonOptions: ["Black", "White", "Red", "Blue", "Green", "Yellow", "Pink", "Purple", "Orange", "Gray", "Brown", "Silver", "Gold"] },
  { name: "Size", commonOptions: ["XS", "S", "M", "L", "XL", "XXL", "XXXL"] },
  { name: "Material", commonOptions: ["Cotton", "Polyester", "Leather", "Metal", "Plastic", "Wood", "Glass", "Ceramic", "Silk", "Wool"] },
  { name: "Pattern", commonOptions: ["Solid", "Striped", "Polka Dot", "Floral", "Geometric", "Abstract", "Plaid", "Checkered"] },
  { name: "Style", commonOptions: ["Classic", "Modern", "Vintage", "Contemporary", "Minimalist", "Bohemian", "Industrial"] },
  { name: "Finish", commonOptions: ["Matte", "Glossy", "Satin", "Brushed", "Polished", "Textured"] },
  { name: "Capacity", commonOptions: ["16GB", "32GB", "64GB", "128GB", "256GB", "512GB", "1TB"] },
  { name: "Weight", commonOptions: ["Light", "Medium", "Heavy"] },
  { name: "Length", commonOptions: ["Short", "Medium", "Long", "Extra Long"] },
  { name: "Width", commonOptions: ["Narrow", "Medium", "Wide"] },
  { name: "Fit", commonOptions: ["Slim", "Regular", "Relaxed", "Loose"] },
  { name: "Sleeve Length", commonOptions: ["Sleeveless", "Short Sleeve", "Long Sleeve", "3/4 Sleeve"] },
  { name: "Neck Type", commonOptions: ["Round Neck", "V-Neck", "Collar", "Hood", "Turtleneck"] },
  { name: "Waist Type", commonOptions: ["Low Rise", "Mid Rise", "High Rise"] },
  { name: "Leg Style", commonOptions: ["Straight", "Slim", "Wide", "Skinny", "Bootcut", "Flared"] },
];

function categoryLineageIdsFromFlatList(flatCategories, categoryId) {
  if (!categoryId || !Array.isArray(flatCategories) || flatCategories.length === 0) return [];
  const byId = new Map(flatCategories.map((c) => [String(c.id), c]));
  const out = [];
  let cur = byId.get(String(categoryId));
  const seen = new Set();
  while (cur && !seen.has(String(cur.id))) {
    seen.add(String(cur.id));
    out.push(String(cur.id));
    const pid = cur.parent_id != null ? String(cur.parent_id) : "";
    cur = pid && byId.has(pid) ? byId.get(pid) : null;
  }
  return out;
}

export default function SingleUploadPage() {
  const router = useRouter();
  const locale = useLocale();
  const copy = getSingleUploadCopy(locale);
  const defaultCategories = [{ id: "uncategorized", name: copy.uncategorized }];
  const [formData, setFormData] = useState({
    title: "",
    SKU: "",
    description: "",
    price: "",
    inventory: "",
    status: "draft",
    seller: "",
    categories: [],
    collection_id: "",
    variants: [],
  });
  const [message, setMessage] = useState({ type: "", text: "" });
  const [categories, setCategories] = useState([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [categoriesApiFailed, setCategoriesApiFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const medusaClient = getMedusaAdminClient();

  useEffect(() => {
    const fetchCategories = async () => {
      try {
        setCategoriesLoading(true);
        setCategoriesApiFailed(false);
        const data = await medusaClient.getAdminHubCategories();
        const list = data.categories || [];
        setCategories(list.length > 0 ? list : defaultCategories);
        if (list.length === 0) setCategoriesApiFailed(true);
      } catch (error) {
        console.error("Error fetching Admin Hub categories:", error);
        setCategories(defaultCategories);
        setCategoriesApiFailed(true);
      } finally {
        setCategoriesLoading(false);
      }
    };
    fetchCategories();
  }, []);

  useEffect(() => {
    // Guard against the literal string "null"/"undefined" — localStorage.setItem() stringifies
    // whatever it's given, so a login response with seller_id: null silently becomes the 4-char
    // string "null" here, which is truthy and used to look valid while actually breaking every
    // downstream check that only tests `!!sellerId` (e.g. the create-product button below).
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem("sellerId") : null;
    const sellerId = raw && raw !== "null" && raw !== "undefined" ? raw : "";
    if (sellerId) setFormData((prev) => ({ ...prev, seller: sellerId }));
  }, []);

  const addVariant = () => {
    setFormData((prev) => ({
      ...prev,
      variants: [...prev.variants, { name: "", options: [{ value: "", sku: "", price: "", inventory: 0 }] }],
    }));
  };

  const removeVariant = (index) => {
    setFormData((prev) => ({ ...prev, variants: prev.variants.filter((_, i) => i !== index) }));
  };

  const updateVariant = (index, field, value) => {
    const next = [...formData.variants];
    next[index] = { ...next[index], [field]: value };
    setFormData((prev) => ({ ...prev, variants: next }));
  };

  const addVariantOption = (variantIndex) => {
    const next = [...formData.variants];
    next[variantIndex].options.push({ value: "", sku: "", price: "", inventory: 0 });
    setFormData((prev) => ({ ...prev, variants: next }));
  };

  const removeVariantOption = (variantIndex, optionIndex) => {
    const next = [...formData.variants];
    next[variantIndex].options = next[variantIndex].options.filter((_, i) => i !== optionIndex);
    setFormData((prev) => ({ ...prev, variants: next }));
  };

  const updateVariantOption = (variantIndex, optionIndex, field, value) => {
    const next = [...formData.variants];
    next[variantIndex].options[optionIndex] = { ...next[variantIndex].options[optionIndex], [field]: value };
    setFormData((prev) => ({ ...prev, variants: next }));
  };

  const applyCommonVariantOptions = (variantIndex, variantType) => {
    const data = VARIANT_TYPES.find((v) => v.name === variantType?.name);
    if (data) {
      updateVariant(variantIndex, "name", data.name);
      updateVariant(
        variantIndex,
        "options",
        data.commonOptions.map((opt) => ({ value: opt, sku: "", price: "", inventory: 0 }))
      );
    }
  };

  const handleSubmit = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    setMessage({ type: "", text: "" });
    const SKU = formData.SKU || formData.title.toUpperCase().replace(/\s+/g, "-").replace(/[^A-Z0-9-]/g, "");
    const slug = SKU.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const sellerId = formData.seller;

    if (!sellerId) {
      setMessage({ type: "error", text: copy.sellerRequired });
      return;
    }

    const validVariants = formData.variants
      .filter((v) => v.name && v.options?.length > 0)
      .map((v) => ({
        name: v.name,
        options: v.options.filter((opt) => opt.value).map((opt) => ({
          value: opt.value,
          sku: opt.sku || "",
          price: opt.price ? parseFloat(opt.price) : undefined,
          inventory: opt.inventory ? parseInt(opt.inventory, 10) : 0,
        })),
      }));

    const metadata = {};
    if (formData.categories.length > 0) {
      const selected = categories.find(
        (c) => formData.categories.includes(c.id) || formData.categories.includes(c.slug)
      );
      if (selected && selected.id !== "uncategorized") {
        const lineage = categoryLineageIdsFromFlatList(categories, selected.id);
        metadata.admin_category_id = String(selected.id);
        metadata.category_id = String(selected.id);
        metadata.category_ids = lineage.length > 0 ? lineage : [String(selected.id)];
      }
    }

    const productData = {
      title: formData.title,
      handle: slug,
      slug,
      sku: SKU,
      description: formData.description || "",
      price: parseFloat(formData.price) || 0,
      inventory: parseInt(formData.inventory, 10) || 0,
      status: formData.status,
      seller: sellerId,
      collection_id: formData.collection_id || undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      variants: validVariants.length > 0 ? validVariants : undefined,
    };

    try {
      setCreating(true);
      await medusaClient.createAdminHubProduct(productData);
      setMessage({ type: "success", text: copy.created });
      setFormData({
        title: "",
        SKU: "",
        description: "",
        price: "",
        inventory: "",
        status: "draft",
        seller: sellerId,
        categories: [],
        collection_id: "",
        variants: [],
      });
    } catch (error) {
      console.error("Error creating product:", error);
      const msg = userError(error, locale, copy.creatingError);
      const hint = msg.includes("Backend unreachable") || msg.includes("NEXT_PUBLIC_MEDUSA_BACKEND_URL")
        ? " Set NEXT_PUBLIC_MEDUSA_BACKEND_URL in .env.local (e.g. https://api.andertal.com) and restart the dev server."
        : "";
      setMessage({ type: "error", text: msg + hint });
    } finally {
      setCreating(false);
    }
  };

  const statusOptions = [
    { label: copy.statusDraft, value: "draft" },
    { label: copy.statusPublished, value: "published" },
    { label: copy.statusArchived, value: "archived" },
  ];

  return (
    <Page
      title={copy.pageTitle}
      backAction={{ content: copy.inventoryBack, onAction: () => router.push("/products/inventory") }}
      primaryAction={{
        content: creating ? copy.creating : copy.createProduct,
        onAction: handleSubmit,
        loading: creating,
        disabled: !formData.seller,
      }}
    >
      <Layout>
        {message.text && (
          <Layout.Section>
            <Banner
              tone={message.type === "success" ? "success" : "critical"}
              onDismiss={() => setMessage({ type: "", text: "" })}
            >
              {message.text}
            </Banner>
          </Layout.Section>
        )}

        {!formData.seller && (
          <Layout.Section>
            <Banner tone="warning">{copy.sellerRequired}</Banner>
          </Layout.Section>
        )}

        {categoriesApiFailed && (
          <Layout.Section>
            <Banner tone="warning">
              {copy.categoriesFallback}
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingSm">
                {copy.newProduct}
              </Text>
              <Divider />
              <form onSubmit={handleSubmit}>
                <BlockStack gap="400">
                  <FormLayout>
                    <TextField
                      label={copy.productTitle}
                      value={formData.title}
                      onChange={(value) => setFormData((prev) => ({ ...prev, title: value }))}
                      autoComplete="off"
                      requiredIndicator
                    />
                    <TextField
                      label={copy.skuHelp}
                      value={formData.SKU}
                      onChange={(value) => setFormData((prev) => ({ ...prev, SKU: value }))}
                      placeholder="PRODUCT-SKU-001"
                      autoComplete="off"
                    />
                    <div>
                      <Text as="label" variant="bodyMd" fontWeight="medium">{copy.description}</Text>
                      <Box paddingBlockStart="100">
                        <ProductDescriptionEditor
                          value={formData.description}
                          onChange={(value) => setFormData((prev) => ({ ...prev, description: value }))}
                          placeholder={copy.descriptionPlaceholder}
                        />
                      </Box>
                    </div>

                    <Box paddingBlockStart="200">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {copy.category}
                      </Text>
                      {categoriesLoading ? (
                        <Box paddingBlockStart="200">
                          <Text as="p" tone="subdued">
                            {copy.loadingCategories}
                          </Text>
                        </Box>
                      ) : (
                        <CategoryDrilldownSelect
                          label={copy.category}
                          labelHidden
                          categories={categories || []}
                          value={formData.categories[0] || ""}
                          onChange={(v) => setFormData((prev) => ({ ...prev, categories: v ? [v] : [] }))}
                          placeholder={copy.selectCategory}
                        />
                      )}
                    </Box>

                    <FormLayout.Group>
                      <TextField
                        label={copy.price}
                        type="number"
                        value={formData.price}
                        onChange={(value) => setFormData((prev) => ({ ...prev, price: value }))}
                        min={0}
                        step={0.01}
                        requiredIndicator
                      />
                      <TextField
                        label={copy.inventory}
                        type="number"
                        value={formData.inventory}
                        onChange={(value) => setFormData((prev) => ({ ...prev, inventory: value }))}
                        min={0}
                        requiredIndicator
                      />
                    </FormLayout.Group>

                    <FormLayout.Group>
                      <Select
                        label={copy.status}
                        options={statusOptions}
                        value={formData.status}
                        onChange={(value) => setFormData((prev) => ({ ...prev, status: value }))}
                      />
                      <TextField
                        label={copy.sellerId}
                        value={formData.seller || ""}
                        onChange={(value) => setFormData((prev) => ({ ...prev, seller: value }))}
                        placeholder={copy.fromLogin}
                        autoComplete="off"
                        disabled={Boolean(formData.seller)}
                      />
                    </FormLayout.Group>
                  </FormLayout>

                  <Divider />
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingSm">
                      {copy.variantsHeading}
                    </Text>
                    <Button onClick={addVariant}>{copy.addVariant}</Button>
                  </InlineStack>

                  {formData.variants.map((variant, vIdx) => (
                    <Box
                      key={vIdx}
                      padding="300"
                      background="bg-fill-secondary"
                      borderRadius="200"
                    >
                      <BlockStack gap="300">
                        <InlineStack align="space-between" blockAlign="center" gap="200">
                          <InlineStack gap="200" blockAlign="center" wrap={false}>
                            <Box minWidth="140px">
                              <TextField
                                label={copy.variantName}
                                labelHidden
                                value={variant.name}
                                onChange={(value) => updateVariant(vIdx, "name", value)}
                                placeholder={copy.variantNamePlaceholder}
                                autoComplete="off"
                              />
                            </Box>
                            <Select
                              label={copy.preset}
                              labelHidden
                              options={[{ label: copy.useCommonOptions, value: "" }, ...VARIANT_TYPES.map((vt) => ({ label: vt.name, value: vt.name }))]}
                              value=""
                              onChange={(value) => applyCommonVariantOptions(vIdx, VARIANT_TYPES.find((v) => v.name === value))}
                            />
                          </InlineStack>
                          <Button variant="plain" tone="critical" onClick={() => removeVariant(vIdx)}>
                            {copy.removeVariant}
                          </Button>
                        </InlineStack>
                        {variant.options.map((opt, oIdx) => (
                          <InlineStack key={oIdx} gap="200" blockAlign="end" wrap>
                            <TextField
                              label={copy.value}
                              labelHidden
                              value={opt.value}
                              onChange={(value) => updateVariantOption(vIdx, oIdx, "value", value)}
                              placeholder={copy.value}
                              autoComplete="off"
                            />
                            <TextField
                              label="SKU"
                              labelHidden
                              value={opt.sku}
                              onChange={(value) => updateVariantOption(vIdx, oIdx, "sku", value)}
                              placeholder="SKU"
                              autoComplete="off"
                            />
                            <TextField
                              label="Price"
                              labelHidden
                              type="number"
                              value={String(opt.price ?? "")}
                              onChange={(value) => updateVariantOption(vIdx, oIdx, "price", value)}
                              placeholder="Price"
                            />
                            <TextField
                              label="Inventory"
                              labelHidden
                              type="number"
                              value={String(opt.inventory ?? "")}
                              onChange={(value) => updateVariantOption(vIdx, oIdx, "inventory", value ? parseInt(value, 10) : 0)}
                              placeholder={copy.qty}
                            />
                            <Button
                              variant="plain"
                              tone="critical"
                              size="slim"
                              onClick={() => removeVariantOption(vIdx, oIdx)}
                            >
                              {copy.remove}
                            </Button>
                          </InlineStack>
                        ))}
                        <Button size="slim" onClick={() => addVariantOption(vIdx)}>
                          {copy.addOption}
                        </Button>
                      </BlockStack>
                    </Box>
                  ))}
                </BlockStack>
              </form>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
