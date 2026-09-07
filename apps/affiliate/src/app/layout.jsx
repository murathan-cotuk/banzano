export const metadata = {
  title: 'Andertal Affiliate Portal',
  description: 'Generate affiliate links, track clicks, and manage payouts for the Andertal marketplace',
}

export default function RootLayout({ children }) {
  return (
    <html>
      <body style={{ margin: 0, fontFamily: "'Inter', system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  )
}
