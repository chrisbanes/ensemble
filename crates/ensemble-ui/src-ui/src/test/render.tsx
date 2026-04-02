import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";

function renderWithProviders(
  ui: ReactElement,
  {
    route = "/",
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    }),
  }: { route?: string; queryClient?: QueryClient } = {},
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        {ui}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

export { renderWithProviders };
