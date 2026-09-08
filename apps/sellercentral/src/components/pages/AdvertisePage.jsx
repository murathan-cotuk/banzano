"use client";

import React from "react";
import styled from "styled-components";
import { Card } from "@andertal/ui";
import { Link } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import { getAdvertisePageCopy } from "@/lib/advertise-pages-i18n";

const Container = styled.div`
  max-width: 1200px;
  margin: 0 auto;
`;

const Title = styled.h1`
  font-size: 32px;
  font-weight: 700;
  margin-bottom: 32px;
  color: #1f2937;
`;

const Section = styled(Card)`
  padding: 24px;
  margin-bottom: 24px;
`;

const PlatformGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 20px;
  margin-top: 24px;
`;

const PlatformCard = styled(Card)`
  padding: 24px;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  cursor: pointer;
  text-decoration: none;
  display: block;
  color: inherit;

  &:hover {
    transform: translateY(-4px);
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
  }
`;

const PlatformIcon = styled.div`
  font-size: 48px;
  margin-bottom: 16px;
`;

const PlatformTitle = styled.h3`
  font-size: 20px;
  font-weight: 600;
  color: #1f2937;
  margin-bottom: 8px;
`;

const PlatformDescription = styled.p`
  font-size: 14px;
  color: #6b7280;
  margin-bottom: 16px;
`;

const ConnectButton = styled.div`
  padding: 8px 16px;
  background-color: #0ea5e9;
  color: white;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
  text-align: center;
  display: inline-block;
`;

export default function AdvertisePage() {
  const locale = useLocale();
  const copy = getAdvertisePageCopy(locale);
  const platforms = [
    {
      name: "Google Ads",
      href: "/advertise/google",
      icon: "fab fa-google",
      color: "#4285F4",
      description: copy.googleDesc,
    },
    {
      name: "Meta (Facebook/Instagram)",
      href: "/advertise/meta",
      icon: "fab fa-facebook",
      color: "#1877F2",
      description: copy.metaDesc,
    },
    {
      name: "TikTok Ads",
      href: "/advertise/tiktok",
      icon: "fab fa-tiktok",
      color: "#000000",
      description: copy.tiktokDesc,
    },
    {
      name: "Pinterest Ads",
      href: "/advertise/pinterest",
      icon: "fab fa-pinterest",
      color: "#BD081C",
      description: copy.pinterestDesc,
    },
  ];

  return (
    <Container>
      <Title>{copy.title}</Title>

      <Section>
        <h2 style={{ fontSize: "20px", fontWeight: "600", color: "#1f2937", marginBottom: "16px" }}>
          {copy.heading}
        </h2>
        <p style={{ color: "#6b7280", marginBottom: "24px" }}>
          {copy.subtitle}
        </p>

        <PlatformGrid>
          {platforms.map((platform) => (
            <Link key={platform.href} href={platform.href}>
              <PlatformCard>
                <PlatformIcon style={{ color: platform.color }}>
                  <i className={platform.icon} />
                </PlatformIcon>
                <PlatformTitle>{platform.name}</PlatformTitle>
                <PlatformDescription>{platform.description}</PlatformDescription>
                <ConnectButton>{copy.connectAccount}</ConnectButton>
              </PlatformCard>
            </Link>
          ))}
        </PlatformGrid>
      </Section>
    </Container>
  );
}

