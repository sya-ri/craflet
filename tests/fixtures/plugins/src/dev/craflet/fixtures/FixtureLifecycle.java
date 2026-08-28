package dev.craflet.fixtures;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/** Writes observable data so a cold backup can prove shutdown completed. */
final class FixtureLifecycle {
    private final Path directory;
    private final Path sharedMarker;
    private final boolean allowFaults = Boolean.getBoolean("craflet.fixture.allowFaults");
    private volatile boolean enabled;

    FixtureLifecycle(Path directory) {
        this.directory = directory;
        String shared = System.getProperty("craflet.fixture.sharedDirectory");
        String instance = System.getProperty("craflet.fixture.instance");
        if (shared != null && instance != null && instance.matches("[a-zA-Z0-9_-]+")) {
            sharedMarker = Path.of(shared).resolve(instance + ".running");
        } else {
            sharedMarker = null;
        }
    }

    void enable() {
        try {
            Files.createDirectories(directory);
            if (sharedMarker != null) {
                Files.createDirectories(sharedMarker.getParent());
                Files.writeString(sharedMarker, FixtureVersion.VALUE + "\n", StandardCharsets.UTF_8);
            }
            write("enabled-version.txt", FixtureVersion.VALUE + "\n");
            if (!Files.exists(directory.resolve("config.yml"))) {
                write("config.yml", "fixture-version: '" + FixtureVersion.VALUE + "'\nmessage: runtime-generated\n");
            }
            write("observed-message.txt", readMessage() + "\n");
            if (!Files.exists(directory.resolve("player-state.txt"))) {
                write("player-state.txt", "fixture-player: original\n");
            }
            write("observed-player-state.txt", Files.readString(directory.resolve("player-state.txt"), StandardCharsets.UTF_8));
            event("enable");
            enabled = true;
            if (allowFaults) {
                watchCrashRequest();
            }
        } catch (IOException exception) {
            throw new UncheckedIOException("Cannot write fixture enable data", exception);
        }
    }

    void disable() {
        enabled = false;
        try {
            Files.createDirectories(directory);
            if (allowFaults) {
                delayShutdown();
            }
            write("saved-version.txt", FixtureVersion.VALUE + "\n");
            if (sharedMarker != null) {
                Files.deleteIfExists(sharedMarker);
            }
            event("disable");
        } catch (IOException exception) {
            throw new UncheckedIOException("Cannot write fixture shutdown data", exception);
        }
    }

    /** This test fixture accepts only its own single-line message scalar, not arbitrary YAML. */
    private String readMessage() throws IOException {
        for (String line : Files.readAllLines(directory.resolve("config.yml"), StandardCharsets.UTF_8)) {
            if (line.startsWith("message:")) {
                String value = line.substring("message:".length()).strip();
                if (value.length() >= 2 && ((value.startsWith("\"") && value.endsWith("\""))
                        || (value.startsWith("'") && value.endsWith("'")))) {
                    value = value.substring(1, value.length() - 1);
                }
                return value;
            }
        }
        throw new IOException("Fixture configuration has no message scalar");
    }

    /** Finite fault injection, enabled only for a dedicated disposable E2E JVM. */
    private void delayShutdown() throws IOException {
        Path request = directory.resolve("stop-delay-ms.txt");
        if (!Files.exists(request)) {
            return;
        }
        long milliseconds = Long.parseLong(Files.readString(request, StandardCharsets.UTF_8).strip());
        if (milliseconds < 0 || milliseconds > 10_000) {
            throw new IOException("Fixture shutdown delay is outside its bounded test range");
        }
        write("stop-delay-started.txt", "delaying\n");
        try {
            Thread.sleep(milliseconds);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IOException("Fixture shutdown delay was interrupted", exception);
        }
    }

    private void watchCrashRequest() {
        Thread watcher = new Thread(() -> {
            try {
                while (enabled) {
                    Path request = directory.resolve("crash.request");
                    if (Files.exists(request)) {
                        Files.delete(request);
                        write("crashed-version.txt", FixtureVersion.VALUE + "\n");
                        System.out.println("CRAFLET_FIXTURE explicit disposable-test halt:17");
                        Runtime.getRuntime().halt(17);
                    }
                    Thread.sleep(50);
                }
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
            } catch (IOException exception) {
                throw new UncheckedIOException("Cannot read fixture crash request", exception);
            }
        }, "craflet-disposable-fixture-faults");
        watcher.setDaemon(true);
        watcher.start();
    }

    private void event(String name) throws IOException {
        String value = name + ":" + FixtureVersion.VALUE + "\n";
        Files.writeString(directory.resolve("events.log"), value, StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        System.out.println("CRAFLET_FIXTURE " + directory.getFileName() + " " + value.strip());
    }

    private void write(String name, String value) throws IOException {
        Files.writeString(directory.resolve(name), value, StandardCharsets.UTF_8);
    }
}
