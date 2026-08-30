package dev.crafleet.fixtures;

import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.event.proxy.ProxyShutdownEvent;
import java.nio.file.Path;

public final class VelocityFixture {
    private final FixtureLifecycle lifecycle =
            new FixtureLifecycle(Path.of("plugins", "crafleetvelocityfixture"));

    @Subscribe
    public void initialize(ProxyInitializeEvent event) {
        lifecycle.enable();
    }

    @Subscribe
    public void shutdown(ProxyShutdownEvent event) {
        lifecycle.disable();
    }
}
