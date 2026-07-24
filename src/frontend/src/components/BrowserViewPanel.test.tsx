import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserViewPanel from './BrowserViewPanel';
import type { BrowserViewResponse, BrowserView } from '../api';

const { fetchBrowserView } = vi.hoisted(() => ({ fetchBrowserView: vi.fn() }));
vi.mock('../api', () => ({ fetchBrowserView }));

const sampleView = (over: Partial<BrowserView> = {}): BrowserView => ({
  image: { data: 'QUJD', mimeType: 'image/jpeg' },
  url: 'http://localhost:5173/dashboard',
  title: 'Dashboard',
  viewport: { width: 1280, height: 800 },
  colorScheme: 'dark',
  version: 4,
  capturedAt: 1_700_000_000_000,
  ...over,
});
const present = (over: Partial<BrowserView> = {}): BrowserViewResponse =>
  ({ available: true, present: true, view: sampleView(over) });

describe('BrowserViewPanel', () => {
  beforeEach(() => {
    fetchBrowserView.mockReset().mockResolvedValue({ available: true, present: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders nothing when the thread has no browser open', async () => {
    const { container } = render(<BrowserViewPanel threadId="thread-1" />);
    await waitFor(() => expect(fetchBrowserView).toHaveBeenCalledWith('thread-1', undefined));
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing and never polls when there is no thread', () => {
    const { container } = render(<BrowserViewPanel threadId={null} />);
    expect(container.firstChild).toBeNull();
    expect(fetchBrowserView).not.toHaveBeenCalled();
  });

  it('shows the page title, viewport and theme, and the captured frame', async () => {
    fetchBrowserView.mockResolvedValue(present());
    render(<BrowserViewPanel threadId="thread-1" />);

    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('1280×800')).toBeInTheDocument();
    expect(screen.getByText('dark')).toBeInTheDocument();
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.src).toBe('data:image/jpeg;base64,QUJD');
  });

  it('polls with the version it already holds so an unchanged frame is not re-sent', async () => {
    fetchBrowserView.mockResolvedValueOnce(present({ version: 4 }));
    render(<BrowserViewPanel threadId="thread-1" />);
    await screen.findByText('Dashboard');

    // The refresh button forces an immediate poll; it must carry the held version.
    fetchBrowserView.mockResolvedValueOnce({ available: true, present: true, unchanged: true, version: 4 });
    fireEvent.click(screen.getByLabelText('Refresh browser view'));
    await waitFor(() => expect(fetchBrowserView).toHaveBeenLastCalledWith('thread-1', 4));
    // An `unchanged` response keeps the frame on screen.
    expect(screen.getByRole('img')).toBeInTheDocument();
  });

  it('falls back to nothing once the browser is torn down', async () => {
    fetchBrowserView.mockResolvedValueOnce(present());
    const { container } = render(<BrowserViewPanel threadId="thread-1" />);
    await screen.findByText('Dashboard');

    // A later poll reports the browser gone → the panel clears.
    fetchBrowserView.mockResolvedValue({ available: true, present: false });
    fireEvent.click(screen.getByLabelText('Refresh browser view'));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('collapses and restores the page image', async () => {
    fetchBrowserView.mockResolvedValue(present());
    render(<BrowserViewPanel threadId="thread-1" />);
    await screen.findByText('Dashboard');
    expect(screen.getByRole('img')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Hide browser view'));
    expect(screen.queryByRole('img')).toBeNull();
    // The header (title) stays visible while collapsed.
    expect(screen.getByText('Dashboard')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Show browser view'));
    expect(screen.getByRole('img')).toBeInTheDocument();
  });
});
